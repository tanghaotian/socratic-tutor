import type { EvalBackend } from '../manager.js';
import type { EvalReport } from '../types.js';

/**
 * 外部评测框架后端占位（IT10，detail.md §9.1）。
 * 注册后可切换（EvalManager.setActive 生效），但本迭代不真正调用外部框架：
 * run 返回 needs_review + backendNote，提示需配置对应框架后使用。
 * 后续接入 promptfoo / agentbench / deepeval 时替换为真实调用。
 */
export class ExternalBackend implements EvalBackend {
  constructor(
    readonly id: string,
    private note: string,
  ) {}

  async run(): Promise<EvalReport> {
    const now = new Date().toISOString();
    return {
      id: `${this.id}-${Date.now()}`,
      engine: 'socratic',
      created: now,
      metrics: {
        rubric: {},
        abWinRate: { candidateWins: 0, baselineWins: 0, ties: 0, winRateDelta: 0 },
      },
      verdict: 'needs_review',
      reasons: [`评测后端 ${this.id} 未接入（${this.note}），请配置对应外部框架后使用 self-built 或切换后端。`],
      judgeDegraded: true,
      threadsReplayed: 0,
      sampledFrom: 0,
      backendNote: `${this.id}: ${this.note}`,
    };
  }
}

/** promptfoo 后端占位 */
export const promptfooBackend = new ExternalBackend(
  'promptfoo',
  '需配置 promptfoo 项目与 provider（如豆包/OpenAI 兼容）后接入',
);

/** AgentBench 后端占位 */
export const agentbenchBackend = new ExternalBackend(
  'agentbench',
  'AgentBench 面向智能体评测，需自建环境/任务集后接入',
);

/** DeepEval 后端占位 */
export const deepevalBackend = new ExternalBackend(
  'deepeval',
  'DeepEval 基于 Python 生态，需 Python sidecar + 评分指标配置后接入',
);

/** 全部外部占位后端 */
export const externalBackends: EvalBackend[] = [
  promptfooBackend,
  agentbenchBackend,
  deepevalBackend,
];
