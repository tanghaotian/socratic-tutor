import type { LLMProvider } from '../providers/index.js';
import type { AnswerSignal } from '../providers/index.js';
import { SignalParser, type SignalParseResult } from './signal.js';
import {
  StrategyManager,
  createSocraticManager,
  type SkillContext,
} from './skills/index.js';

/** 苏格拉底提问策略 */
export type SocraticStrategy = 'open' | 'focus' | 'conflict' | 'self_eval' | 'hint';

/** 教学动作 */
export type TeachingAction =
  | { type: 'ask'; strategy: SocraticStrategy; content: string; concept?: string; promptLevel: number }
  | { type: 'hint'; content: string; promptLevel: number }
  | { type: 'evaluate'; content: string; feedback: string }
  | { type: 'explain'; content: string; concept: string }
  | { type: 'recommend'; resourceIds: string[] }
  | { type: 'assess_self'; content: string };

/** 画像/自适应最小化接口（IT3 之前先用最小契约） */
export interface AdaptiveProfile {
  /** 调整后的难度(0~目标深度)，由画像计算 */
  adjustDepth(signal: AnswerSignal): number;
  /** 当前掌握度 0~1 */
  mastery(): number;
}

/** 引擎输入上下文 */
export interface SocraticContext {
  /* 用户最新回答 */
  answer: string;
  /* 可选：当前学习概念 */
  concept?: string;
  /* 可选：已由外部解析好的信号（例如语音流程），缺省则引擎内部解析 */
  signal?: SignalParseResult;
  /* 学习画像/自适应（IT3 注入；缺省用默认画像） */
  profile?: AdaptiveProfile;
  /* 最近对话历史（用于连续困惑/连续正确判定） */
  history?: AnswerSignal[];
}

/** 默认画像（无画像注入时兜底）：难度固定 1，掌握度 0.5 */
function defaultProfile(): AdaptiveProfile {
  return {
    adjustDepth: () => 1,
    mastery: () => 0.5,
  };
}

/**
 * 苏格拉底对话主逻辑（IT2，IT9 起经 StrategyManager 消费能力 skill）。
 * 默认激活 `socratic.core` skill（确定性路由 + LLM 文案），行为与旧版一致；
 * 可注入自定义 StrategyManager 增加/替换/叠加 skill。
 */
export class SocraticEngine {
  private parser: SignalParser;
  private manager: StrategyManager;

  constructor(
    private llm: LLMProvider,
    skills?: StrategyManager,
  ) {
    this.parser = new SignalParser(llm);
    this.manager = skills ?? createSocraticManager(llm);
  }

  /** 暴露当前 skill 管理器（注册/启停/快照用） */
  get skills(): StrategyManager {
    return this.manager;
  }

  async generateAction(ctx: SocraticContext): Promise<TeachingAction> {
    // 1) 解析信号（可注入）
    const signal =
      ctx.signal ??
      (await this.parser.parse({ answer: ctx.answer, concept: ctx.concept }));

    // 2) 构造 skill 上下文，交给策略管理器叠加执行
    const skillCtx: SkillContext = {
      input: ctx.answer,
      concept: ctx.concept,
      signal,
      history: ctx.history ?? [],
      profile: ctx.profile ?? defaultProfile(),
      llm: this.llm,
    };
    const results = await this.manager.run('socratic', skillCtx);

    // 3) 取最终动作：叠加序列中最后一个产出的动作（后 skill 可改写前 skill）
    let finalAction: TeachingAction | undefined;
    for (const r of results) {
      if (r.engine === 'socratic' && r.action) finalAction = r.action;
    }
    if (!finalAction) throw new Error('socratic: 无激活 skill 产出教学动作');
    return finalAction;
  }
}
