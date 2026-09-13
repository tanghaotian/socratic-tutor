import {
  JsonRpcError,
  JsonRpcErrorCode,
  asObject,
  requiredString,
} from './types.js';
import type { McpContext } from './context.js';
import { recordTurn } from '../engines/conversation.js';

/** MCP 规范的输入参数 JSON Schema（2025-06-18：type/properties/required + additionalProperties） */
export interface McpInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  /** 严格模式：禁止额外字段（MCP 推荐，避免误传未声明的入参） */
  additionalProperties: false;
}

/** 单个 MCP 工具的原型定义（用于 tools/list，遵循 MCP Tool 对象结构） */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
}

/** 注册表内使用的宽松入参 schema（additionalProperties 由 listTools 统一补齐） */
interface RegistryInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** 工具实现签名：入参对象 + 共享上下文 → 结果 */
export type McpToolHandler = (params: Record<string, unknown>, ctx: McpContext) => Promise<unknown> | unknown;

/** 注册表中的工具 */
export interface McpTool {
  spec: {
    name: string;
    description: string;
    inputSchema: RegistryInputSchema;
  };
  handle: McpToolHandler;
}

/** 工具实现：chat_socratic —— 与 /api/chat 语义一致：解析信号→更新画像→生成教学动作（BUG-004：共用编排并注入真实 history） */
async function chatSocratic(params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const text = requiredString(params, 'text');
  const topicId: string | undefined = typeof params.topicId === 'string' && params.topicId ? params.topicId : undefined;
  const { signal, action } = await recordTurn(
    {
      store: ctx.store,
      parser: ctx.parser,
      profile: ctx.profile,
      socratic: ctx.socratic,
      maxHistory: ctx.cfg.conversation.maxHistory,
    },
    { learnerId: ctx.learnerId, topicId, userText: text },
  );
  return { reply: action, signal };
}

/** 工具实现：get_learner_profile —— 读取当前学员画像 */
async function getLearnerProfile(params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const topicId = typeof params.topicId === 'string' ? params.topicId : undefined;
  const profile = ctx.profile.getOrCreate(ctx.learnerId);
  return topicId ? { profile, topicProfile: ctx.profile.toAdaptiveView(ctx.learnerId, topicId) } : { profile };
}

/** 工具实现：trigger_reflection —— 手动触发每周反思 */
async function triggerReflection(_params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const { report, markdownPath } = await ctx.reflection.run('manual', {
    outputDir: ctx.cfg.storage.dir,
  }, ctx.remind);
  return { report, markdownPath };
}

/** 工具实现：confirm_upgrade —— 确认反思报告（draft → confirmed） */
async function confirmUpgrade(params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const id = requiredString(params, 'id');
  try {
    const report = ctx.reflection.confirm(id);
    return { status: report.status };
  } catch (e) {
    throw new JsonRpcError(JsonRpcErrorCode.ServerError, e instanceof Error ? e.message : String(e));
  }
}

/** 工具实现：summarize_resource —— 资料结构化总结并入库 knowledge/skills/<slug>.md */
async function summarizeResource(params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const sourceType = requiredString(params, 'sourceType');
  const content = requiredString(params, 'content');
  const sourceTitle = typeof params.sourceTitle === 'string' ? params.sourceTitle : undefined;
  const result = await ctx.resource.bookToSkill(sourceType as never, content, sourceTitle);
  return { summary: result, skillMarkdownPath: result.file };
}

/** 工具实现：plan_generate —— 生成学习计划 draft（与 /api/plan/generate 一致） */
async function planGenerate(params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const topicId = requiredString(params, 'topicId');
  const periodDays = typeof params.periodDays === 'number' ? params.periodDays : undefined;
  try {
    const { plan, markdownPath } = await ctx.planEngine.run(ctx.learnerId, topicId, {
      outputDir: ctx.cfg.storage.dir,
      periodDays,
      llm: ctx.providers.getLLM(),
      strategy: ctx.strategies.plan,
      weights: ctx.cfg.plan.reviewWeights,
    });
    return { plan, markdownPath };
  } catch (e) {
    throw new JsonRpcError(JsonRpcErrorCode.ServerError, e instanceof Error ? e.message : String(e));
  }
}

/** 工具实现：review_generate —— 生成复盘 draft（与 /api/review/generate 一致） */
async function reviewGenerate(params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const planId = typeof params.planId === 'string' && params.planId ? params.planId : ctx.planEngine.latest()?.id;
  if (!planId) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, '尚无学习计划，请先生成并确认计划（plan_generate）');
  }
  try {
    const { review, markdownPath } = await ctx.reviewEngine.run(ctx.learnerId, planId, {
      outputDir: ctx.cfg.storage.dir,
      llm: ctx.providers.getLLM(),
      strategy: ctx.strategies.review,
      weights: ctx.cfg.plan.reviewWeights,
      anchorStreak: ctx.cfg.plan.anchorStreak,
      anchorThreshold: ctx.cfg.plan.anchorThreshold,
    });
    return { review, markdownPath };
  } catch (e) {
    throw new JsonRpcError(JsonRpcErrorCode.ServerError, e instanceof Error ? e.message : String(e));
  }
}

/** 7 个 MCP 工具注册表（design §11） */
export const MCP_TOOLS: McpTool[] = [
  {
    spec: {
      name: 'chat_socratic',
      description: '发起一轮苏格拉底式对话：解析学员回答信号 → 更新画像 → 生成分层提问/提示动作。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '学员输入的回答/表述' } },
        required: ['text'],
      },
    },
    handle: chatSocratic,
  },
  {
    spec: {
      name: 'get_learner_profile',
      description: '读取学员当前学习画像（掌握度/兴趣等，可按主题查看子画像）。',
      inputSchema: {
        type: 'object',
        properties: { topicId: { type: 'string', description: '可选：指定主题的子画像' } },
      },
    },
    handle: getLearnerProfile,
  },
  {
    spec: {
      name: 'trigger_reflection',
      description: '手动触发每周自我反思，生成《升级需求文档》草案。',
      inputSchema: { type: 'object', properties: {} },
    },
    handle: triggerReflection,
  },
  {
    spec: {
      name: 'confirm_upgrade',
      description: '确认反思报告，使草案进入已确认状态（触发后续升级流程）。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '反思报告 id' } },
        required: ['id'],
      },
    },
    handle: confirmUpgrade,
  },
  {
    spec: {
      name: 'summarize_resource',
      description: '对书籍/论文/视频资料做结构化总结，并写入 knowledge/skills/<slug>.md（book-to-skill）。',
      inputSchema: {
        type: 'object',
        properties: {
          sourceType: { type: 'string', description: 'book | paper | video' },
          content: { type: 'string', description: '资料正文/要点' },
          sourceTitle: { type: 'string', description: '可选：资料标题' },
        },
        required: ['sourceType', 'content'],
      },
    },
    handle: summarizeResource,
  },
  {
    spec: {
      name: 'plan_generate',
      description: '为指定主题生成学习计划草案（data/plans/<id>.md），draft 状态待确认。',
      inputSchema: {
        type: 'object',
        properties: {
          topicId: { type: 'string', description: '学习主题' },
          periodDays: { type: 'number', description: '可选：周期天数' },
        },
        required: ['topicId'],
      },
    },
    handle: planGenerate,
  },
  {
    spec: {
      name: 'review_generate',
      description: '为最新或指定学习计划生成复盘草案（data/reviews/<id>.md，含四维加权评分）。',
      inputSchema: {
        type: 'object',
        properties: { planId: { type: 'string', description: '可选：学习计划 id，缺省用最新计划' } },
      },
    },
    handle: reviewGenerate,
  },
];

const TOOL_MAP = new Map<string, McpTool>(MCP_TOOLS.map((t) => [t.spec.name, t]));

/** 是否存在该工具 */
export function hasTool(name: string): boolean {
  return TOOL_MAP.has(name);
}

/** tools/list 的 MCP 规范结果：{ tools: Tool[] }，每个 Tool 的 inputSchema 补齐 additionalProperties:false */
export function listTools(): { tools: McpToolSpec[] } {
  const tools = MCP_TOOLS.map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    inputSchema: {
      type: 'object' as const,
      properties: t.spec.inputSchema.properties,
      ...(t.spec.inputSchema.required ? { required: t.spec.inputSchema.required } : {}),
      additionalProperties: false as const,
    },
  }));
  return { tools };
}

/** tools/call 分发：按 name 找到工具并校验入参后执行 */
export async function callTool(name: string, rawArguments: unknown, ctx: McpContext): Promise<unknown> {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `未知工具：${name}`);
  }
  const params = asObject(rawArguments);
  return tool.handle(params, ctx);
}