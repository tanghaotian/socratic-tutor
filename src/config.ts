import 'dotenv/config';
import type { RagBackend } from './storage/rag.js';

/** 单节点 vs 多节点部署模式（IT16） */
export type DeployMode = 'single' | 'multi';

/** 单个 OpenAI 兼容 LLM 的连接配置（单一事实来源，接入 OpenAPI 兼容模型无需改代码） */
export interface LLMModel {
  id: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

/** 解析 LLM_EXTRA_MODELS（JSON 数组）：用于零代码接入额外的 OpenAI 兼容模型。坏输入返回空数组。 */
function parseExtraModels(raw?: string): LLMModel[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m.id === 'string' && m.apiKey && m.model)
      .map((m) => ({
        id: String(m.id),
        apiKey: String(m.apiKey),
        baseURL: String(m.baseURL ?? ''),
        model: String(m.model),
      }));
  } catch {
    return [];
  }
}

/** 运行时配置：从环境变量读取，提供默认值 */
export const config = {
  env: process.env.NODE_ENV ?? 'development',

  llm: {
    provider: process.env.LLM_PROVIDER ?? 'doubao',
    // 评测 judge 独立配置：可指定更强大的模型做 LLM-as-Judge（默认跟随主模型）
    judge: {
      provider: process.env.JUDGE_PROVIDER ?? '',
      model: process.env.JUDGE_MODEL ?? '',
    },
    // OpenAI 兼容模型注册清单（单一事实来源，统一由 OpenAICompatProvider 承载）。
    // 内置三项用独立 env 覆盖；追加新模型只需在 LLM_EXTRA_MODELS 加一项 JSON，无需改代码。
    models: [
      {
        id: 'doubao',
        apiKey: process.env.DOUBAO_API_KEY ?? '',
        baseURL: process.env.DOUBAO_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
        model: process.env.DOUBAO_MODEL ?? '',
      },
      {
        id: 'deepseek',
        apiKey: process.env.DEEPSEEK_API_KEY ?? '',
        baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      },
      {
        id: 'qwen',
        apiKey: process.env.QWEN_API_KEY ?? '',
        baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: process.env.QWEN_MODEL ?? 'qwen3.7-flash',
      },
      ...parseExtraModels(process.env.LLM_EXTRA_MODELS),
    ],
  },

  voice: {
    asrProvider: process.env.ASR_PROVIDER ?? '',
    ttsProvider: process.env.TTS_PROVIDER ?? '',
    asrAppid: process.env.ASR_APPID ?? '',
    asrToken: process.env.ASR_ACCESS_TOKEN ?? '',
    asrResourceId: process.env.ASR_RESOURCE_ID ?? '',
    ttsAppid: process.env.TTS_APPID ?? '',
    ttsToken: process.env.TTS_ACCESS_TOKEN ?? '',
    ttsCluster: process.env.TTS_CLUSTER ?? '',
    ttsVoiceType: process.env.TTS_VOICE_TYPE ?? '',
  },

  reflection: {
    cron: process.env.REFLECTION_CRON ?? '0 19 * * 5',
    reminderProvider: process.env.REMINDER_PROVIDER ?? 'web',
  },

  plan: {
    // 锚定反思触发：连续 anchorStreak 次复盘加权分 < anchorThreshold
    anchorStreak: Number(process.env.PLAN_ANCHOR_STREAK ?? 2),
    anchorThreshold: Number(process.env.PLAN_ANCHOR_THRESHOLD ?? 0.5),
    // 复盘加权评分权重（读取时 clamp 并归一化，见 scoring.ts）
    reviewWeights: {
      goalCompletion: Number(process.env.PLAN_W_GOAL ?? 0.4),
      signalAccuracy: Number(process.env.PLAN_W_SIGNAL ?? 0.2),
      frequencyRate: Number(process.env.PLAN_W_FREQ ?? 0.2),
      masteryChange: Number(process.env.PLAN_W_MASTERY ?? 0.2),
    },
    plansDir: process.env.PLAN_DIR ?? './data/plans',
    reviewsDir: process.env.REVIEW_DIR ?? './data/reviews',
    anchorsDir: process.env.ANCHOR_DIR ?? './data/anchors',
    activeStrategiesFile: process.env.PLAN_ACTIVE_JSON ?? './data/plans/active.json',
    strategyEval: {
      planWeight: Number(process.env.PLAN_EVAL_PLAN_W ?? 0.5),
      reviewWeight: Number(process.env.PLAN_EVAL_REVIEW_W ?? 0.5),
      minScore: Number(process.env.PLAN_EVAL_MIN ?? 6),
    },
  },

  eval: {
    backend: process.env.EVAL_BACKEND ?? 'self-built',
    weeklyCron: process.env.EVAL_WEEKLY_CRON ?? '0 20 * * 5',
    monthlyCron: process.env.EVAL_MONTHLY_CRON ?? '0 9 1 * *',
    threadsDir: process.env.EVAL_THREADS_DIR ?? './data/threads',
    outputDir: process.env.EVAL_OUTPUT_DIR ?? './data/evals',
    weeklySample: Number(process.env.EVAL_WEEKLY_SAMPLE ?? 25),
  },

  // IT16 流量回放录制层：把真实对话录制为冻结线程，供评测回放与自我更新采样
  tracing: {
    enabled: process.env.TRACING_ENABLED !== 'false', // 默认开，可插拔中间件
    threadsDir: process.env.TRACING_DIR ?? (process.env.EVAL_THREADS_DIR ?? './data/threads'),
    goldenFile: process.env.TRACING_GOLDEN_FILE ?? './data/threads/golden.json',
    // 分层抽样：fail-first 倍率（mistake/confused 信号出现时被选中概率提升）
    failureWeight: Number(process.env.TRACING_FAILURE_WEIGHT ?? 3),
    // 抽样目标量（用于定时刷新黄金数据集的批次上限）
    sampleSize: Number(process.env.TRACING_SAMPLE_SIZE ?? 50),
  },

  // IT16 多节点部署准备：默认单机
  deploy: {
    mode: process.env.DEPLOY_MODE === 'multi' ? 'multi' : 'single',
    // 分布式锁后端：single=进程内 | file=文件锁（多进程同机/NFS） | db=SQLite 锁表（多节点共享库）
    lockBackend: (process.env.LOCK_BACKEND ?? 'single') as 'single' | 'file' | 'db',
    lockDir: process.env.LOCK_DIR ?? './data/locks',
    // lock ttl 毫秒：持锁超时自动释放（防崩溃残留）
    lockTtlMs: Number(process.env.LOCK_TTL_MS ?? 300000),
  },

  storage: {
    dir: process.env.STORAGE_DIR ?? './data',
    knowledgeDir: process.env.KNOWLEDGE_DIR ?? './knowledge/skills',
    // IT15 向量 RAG：keyword（默认=纯关键词，降级兜底）| hybrid（需配 EMBEDDING_MODEL 才启用语义）
    ragBackend: (process.env.RAG_BACKEND ?? 'keyword') === 'hybrid'
      ? ('hybrid' as RagBackend)
      : ('keyword' as RagBackend),
  },

  embedding: {
    // IT15：向量检索的嵌入配置（OpenAI 兼容 /v1/embeddings）
    provider: process.env.EMBEDDING_PROVIDER ?? '',
    model: process.env.EMBEDDING_MODEL ?? '',
    dim: Number(process.env.EMBEDDING_DIM ?? 1536),
  },

  // IT17 MCP Server（进程外/HTTP JSON-RPC，挂载于既有 Web 服务的 /mcp）
  mcp: {
    enabled: process.env.MCP_ENABLED !== 'false',
    transport: process.env.MCP_TRANSPORT ?? 'http',
  },

  // BUG-004：会话历史参与「连续信号」判定的轮数上限（越大越吃 token，需有界）
  conversation: {
    maxHistory: Number(process.env.CONVERSATION_MAX_HISTORY ?? 20),
  },
};

export type AppConfig = typeof config;