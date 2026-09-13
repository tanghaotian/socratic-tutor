import fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import type { AppConfig } from '../config.js';
import type { ProviderContainer } from '../providers/index.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { AudioStore } from '../storage/audio.js';
import { SocraticEngine } from '../engines/socratic.js';
import { SignalParser } from '../engines/signal.js';
import { ProfileEngine } from '../engines/profile.js';
import { ReflectionEngine } from '../engines/reflection.js';
import { createEngineManagerFromRegistry } from '../engines/skillgen/index.js';
import { runVoiceTurn } from '../engines/voice.js';
import { ResourceEngine } from '../engines/resource.js';
import {
  StudyPlanEngine,
  ReviewEngine,
  createStrategyManagerFromRegistry,
  runStrategyEval,
  readActiveStrategies,
  applyStrategy,
  latestAnchor,
  type PlanReviewStrategyConfig,
  type StrategyEvalThread,
} from '../engines/plans/index.js';
import { loadFrozenThreads } from '../scheduler/eval-cron.js';
import { ReplayRecorder, buildThreadId } from '../tracing/replay.js';
import { registerMcpServer } from '../mcp/index.js';
import type { McpContext } from '../mcp/context.js';
import { recordTurn, actionText, type ConversationDeps } from '../engines/conversation.js';

/**
 * IT5/IT6 Web 服务：Fastify REST + 静态前端托管。
 * 路由遵循 detail.md §4 API 契约。
 */
export async function startWebServer(cfg: AppConfig, providers: ProviderContainer): Promise<void> {
  const app = fastify();

  // 依赖装配
  const store = new SqliteStorage(path.join(cfg.storage.dir, 'learner.db'));
  const llm = providers.getLLM();
  // §8.2.1：引擎 manager = 默认组合 + 已应用 skill（data/skills/active.json 注册表）
  const socratic = new SocraticEngine(
    llm,
    createEngineManagerFromRegistry('socratic', { dir: cfg.storage.dir, llm }),
  );
  const parser = new SignalParser(llm);
  const profile = new ProfileEngine(
    store,
    createEngineManagerFromRegistry('profile', { dir: cfg.storage.dir }),
  );
  const reflection = new ReflectionEngine(llm, store);
  const remind = providers.getReminder(cfg.reflection.reminderProvider);
  const audioStore = new AudioStore(cfg.storage.dir);
  const resource = new ResourceEngine(llm, providers.getSearch(), cfg.storage.knowledgeDir, {
    embedding: providers.getEmbedding() ?? undefined,
    ragBackend: cfg.storage.ragBackend,
  });
  // 0.4.0：计划/复盘引擎（策略=已应用注册表叠加默认；LLM 缺失时降级启发式）
  const strategies = createStrategyManagerFromRegistry(cfg.storage.dir, llm);
  const planEngine = new StudyPlanEngine(store, profile);
  const reviewEngine = new ReviewEngine(store, profile);

  // IT16：流量回放录制层（默认开，把真实对话录制为冻结线程供评测/黄金样本）
  const recorder = new ReplayRecorder(cfg.tracing.threadsDir);

  const learnerId = 'local-user'; // 单用户本地实用，后续可扩展多用户

  // BUG-004：一轮对话的共享编排（读真实 history → 信号 → 画像 → 动作 → 落库会话）
  const conversation: ConversationDeps = {
    store,
    parser,
    profile,
    socratic,
    maxHistory: cfg.conversation.maxHistory,
  };

  // IT17：MCP 可复用的共享上下文（与 Web 路由同批引擎/存储/provider）
  const mcpCtx: McpContext = {
    cfg,
    providers,
    store,
    learnerId,
    parser,
    profile,
    socratic,
    reflection,
    resource,
    planEngine,
    reviewEngine,
    remind,
    strategies,
  };

  // ---- 静态前端 ----
  const publicDir = path.resolve('public');
  await app.register(fastifyStatic, { root: publicDir });
  await app.register(multipart);
  // 音频静态访问（/audio/<file>.wav）
  await app.register(fastifyStatic, {
    root: path.resolve(path.join(cfg.storage.dir, 'audio')),
    prefix: '/audio/',
    decorateReply: false,
  });

  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => reply.sendFile('index.html'));

  // ---- API ----
  /** 文本对话：解析信号 → 更新画像 → 生成教学动作（BUG-004：注入真实会话 history） */
  app.post('/api/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { text?: string; topicId?: string };
    if (!body?.text) {
      return reply.code(400).send({ error: '缺少 text' });
    }
    try {
      const topicId = body.topicId;
      const { signal, action } = await recordTurn(conversation, {
        learnerId,
        topicId,
        userText: body.text,
      });
      // IT16：录制为冻结线程（供评测回放/黄金样本），失败不影响主流程
      if (cfg.tracing.enabled) {
        try {
          recorder.record({
            threadId: buildThreadId(learnerId, topicId),
            topic: topicId,
            userText: body.text,
            agentText: actionText(action),
            signal: signal,
          });
        } catch { /* 录制失败静默 */ }
      }
      return { reply: action };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 语音对话（Phase1 非实时）：上传整段录音 → ASR → 对话 → TTS → 返回文本+音频 URL */
  app.post('/api/voice/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const parts = request.parts();
    let audio: Buffer | null = null;
    let fileName = `up-${Date.now()}`;
    let topicId: string | undefined;

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        audio = Buffer.concat(chunks);
      } else if (part.type === 'field') {
        if (part.fieldname === 'topicId' && part.value != null) topicId = String(part.value);
      }
    }

    if (!audio || audio.length === 0) {
      return reply.code(400).send({ error: '缺少音频文件字段（file）' });
    }

    try {
      const result = await runVoiceTurn(
        {
          asr: providers.getASR(),
          tts: providers.getTTS(),
          audioStore,
          processText: async (text: string) => {
            // BUG-004：与 /api/chat 共用同一编排（含真实会话 history）
            const { signal, action } = await recordTurn(conversation, {
              learnerId,
              topicId,
              userText: text,
            });
            const agentText = actionText(action);
            // IT16：录制为冻结线程（失败不影响主流程）
            if (cfg.tracing.enabled) {
              try {
                recorder.record({
                  threadId: buildThreadId(learnerId, topicId),
                  topic: topicId,
                  userText: text,
                  agentText,
                  signal,
                });
              } catch { /* 录制失败静默 */ }
            }
            return agentText;
          },
        },
        audio,
        fileName,
      );
      // 产品化可见性：Mock 占位模式下显式标记，前端可据此提示"非真实识别"
      return {
        ...result,
        replyType: result.replyText,
        voiceDegraded: providers.isVoiceDegraded(),
        asrProvider: providers.getASR().id,
        ttsProvider: providers.getTTS().id,
      };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 学习画像 */
  app.get('/api/profile', async () => profile.getOrCreate(learnerId));

  /** 学习目标/主题设置 */
  app.post('/api/learn/topic', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { topicId?: string; title?: string; targetLevel?: number };
    if (!body?.topicId) return reply.code(400).send({ error: '缺少 topicId' });
    // 画像引擎已通过学习自动维护掌握度；此处仅返回当前画像作为确认
    return { ok: true, profile: profile.getOrCreate(learnerId) };
  });

  /** 资料结构化总结（book/paper/video）→ 生成 knowledge/skills/<slug>.md */
  app.post('/api/resource/summarize', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { sourceType?: string; content?: string; sourceTitle?: string };
    if (!body?.content || !body.sourceType) {
      return reply.code(400).send({ error: '缺少 sourceType 或 content' });
    }
    try {
      const result = await resource.bookToSkill(
        body.sourceType as never,
        body.content,
        body.sourceTitle,
      );
      return {
        summary: result,
        skillMarkdownPath: result.file,
      };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 资料/知识检索：联网 + 本地 RAG（IT15：RAG_BACKEND=hybrid 时走语义+关键词混合，否则纯关键词） */
  app.post('/api/resource/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { query?: string; topK?: number };
    if (!body?.query) return reply.code(400).send({ error: '缺少 query' });
    const [web, local] = await Promise.all([
      resource.searchWeb(body.query),
      resource.queryRagHybrid(body.query, body.topK ?? 3),
    ]);
    return { web, local, backend: cfg.storage.ragBackend };
  });

  /** 手动触发反思 */
  app.post('/api/reflect', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { report, markdownPath } = await reflection.run('manual', {
        outputDir: cfg.storage.dir,
      }, remind);
      return { report, markdownPath };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 最新反思报告（草稿优先） */
  app.get('/api/reflection/latest', async () => reflection.latest() ?? null);

  /** 确认反思报告 */
  app.post('/api/reflect/:id/confirm', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      const report = reflection.confirm(id);
      return { status: report.status };
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- 0.4.0 学习计划 + 复盘阶段 ----

  /** 生成学习计划（draft）→ data/plans/<id>.md */
  app.post('/api/plan/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { topicId?: string; periodDays?: number };
    if (!body?.topicId) return reply.code(400).send({ error: '缺少 topicId' });
    try {
      const { plan, markdownPath } = await planEngine.run(learnerId, body.topicId, {
        outputDir: cfg.storage.dir,
        periodDays: body.periodDays,
        llm,
        strategy: strategies.plan,
        weights: cfg.plan.reviewWeights,
      });
      return { plan, markdownPath };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 最新学习计划（草稿优先） */
  app.get('/api/plan/latest', async () => planEngine.latest() ?? null);

  /** 确认学习计划：draft → confirmed */
  app.post('/api/plan/:id/confirm', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      const plan = planEngine.confirm(id);
      return { status: plan.status };
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 生成复盘（draft）→ data/reviews/<id>.md，含加权评分 */
  app.post('/api/review/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { planId?: string };
    const planId = body?.planId ?? planEngine.latest()?.id;
    if (!planId) return reply.code(400).send({ error: '尚无学习计划，请先生成并确认计划' });
    try {
      const { review, markdownPath } = await reviewEngine.run(learnerId, planId, {
        outputDir: cfg.storage.dir,
        llm,
        strategy: strategies.review,
        weights: cfg.plan.reviewWeights,
        anchorStreak: cfg.plan.anchorStreak,
        anchorThreshold: cfg.plan.anchorThreshold,
      });
      return { review, markdownPath };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 最新复盘（草稿优先） */
  app.get('/api/review/latest', async () => reviewEngine.latest() ?? null);

  /** 确认复盘：draft → confirmed，触发交叉确认 + 锚定反思（返回 anchorAdjustment?） */
  app.post('/api/review/:id/confirm', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      const { review, anchorAdjustment } = await reviewEngine.confirm(id, {
        outputDir: cfg.storage.dir,
        llm,
        strategy: strategies.review,
        weights: cfg.plan.reviewWeights,
        anchorStreak: cfg.plan.anchorStreak,
        anchorThreshold: cfg.plan.anchorThreshold,
      });
      return { status: review.status, anchorAdjustment: anchorAdjustment ?? null };
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 最近一次锚定调整审计（无则 null） */
  app.get('/api/anchors/latest', async () => latestAnchor(store, learnerId));

  /** 当前已应用策略注册表（data/plans/active.json） */
  app.get('/api/strategy/active', async () => readActiveStrategies(cfg.storage.dir));

  /** 组合加权评测（MVP 手动触发）：候选通过才写入 active.json */
  app.post('/api/strategy/eval', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { candidate?: PlanReviewStrategyConfig[]; threads?: StrategyEvalThread[] };
    const candidate = body?.candidate;
    if (!candidate || candidate.length === 0) {
      return reply.code(400).send({ error: '缺少 candidate（plan/review 策略配置数组）' });
    }
    try {
      const active = readActiveStrategies(cfg.storage.dir);
      const baseline: PlanReviewStrategyConfig[] = active.length
        ? active
        : [
            { id: 'plans.default', kind: 'plan', version: '1.0.0' },
            { id: 'reviews.default', kind: 'review', version: '1.0.0' },
          ];
      let threads = body?.threads ?? (loadFrozenThreads(cfg.eval.threadsDir, [path.basename(cfg.tracing.goldenFile)]) as StrategyEvalThread[]);
      if (threads.length === 0) {
        threads = [
          { id: 'stub', topic: '微积分', turns: [{ role: 'user', content: '先导知识', signal: 'correct' }] },
        ];
      }
      const report = await runStrategyEval({
        baseline,
        candidate,
        threads,
        judgeProvider: providers.getJudge(),
        outputDir: cfg.storage.dir,
        planWeight: cfg.plan.strategyEval.planWeight,
        reviewWeight: cfg.plan.strategyEval.reviewWeight,
        minScore: cfg.plan.strategyEval.minScore,
      });
      if (report.verdict === 'accepted') {
        for (const c of candidate) applyStrategy(c, cfg.storage.dir);
      }
      return { report, applied: report.verdict === 'accepted' };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // IT17：挂载 MCP Server（/mcp，MCP_ENABLED=false 时不注册）
  registerMcpServer(app, mcpCtx, cfg);

  // 启动
  const port = Number(process.env.PORT ?? 5173);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`[web] Fastify 已启动: http://127.0.0.1:${port}`);
}