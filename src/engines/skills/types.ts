import type { LLMProvider, AnswerSignal } from '../../providers/index.js';
import type { TeachingAction, AdaptiveProfile } from '../socratic.js';
import type { LearnerProfile, AdaptiveParams } from '../profile.js';
import type { SignalParseResult } from '../signal.js';

/** 目标引擎 */
export type SkillEngine = 'socratic' | 'profile';

/** skill 中性描述（供反思/评测使用） */
export interface SkillMeta {
  id: string;
  engine: SkillEngine;
  version: string;
  purpose: string;
  author?: string;
}

/**
 * skill 应用上下文（detail.md §8.1）。
 * 由引擎/调用方构造，manager 逐 skill 注入；叠加时 prevAction 携带上一个 skill 的产出。
 */
export interface SkillContext {
  /** 用户回答 / 画像查询输入 */
  input: string;
  /** 当前学习概念 / topicId */
  concept?: string;
  /** 已解析的回答信号（socratic 侧；profile 侧由调用方构造轻量结果） */
  signal?: SignalParseResult;
  /** 画像快照：socratic 侧为 AdaptiveProfile 最小契约，profile 侧为 LearnerProfile 全量 */
  profile: LearnerProfile | AdaptiveProfile;
  /** 最近信号历史（连续判定用） */
  history: AnswerSignal[];
  /** 自适应参数（可选） */
  adaptive?: AdaptiveParams;
  /** LLM 提供器（可选，经 Provider，不直接依赖 SDK） */
  llm?: LLMProvider;
  /** 前一个 skill 产出的教学动作（叠加改写用） */
  prevAction?: TeachingAction;
}

/** 画像/自适应参数增量（profile 侧 skill 产出） */
export interface ProfileDelta {
  /** 掌握度增量：topic → levelDelta 与 strengths/mistakes 追加 */
  masteryDelta?: Record<string, { levelDelta: number; mistakes?: string[]; strengths?: string[] }>;
  /** 兴趣权重增量：topic → 增量值 */
  interestDelta?: Record<string, number>;
  /** 会话计数增量（默认 1） */
  sessionsDelta?: number;
  /** 学习速度系数增量（下限 0.1） */
  learningSpeedDelta?: number;
}

/** skill 应用结果：socratic 侧产出教学动作，profile 侧产出画像增量 */
export type SkillResult =
  | { engine: 'socratic'; action?: TeachingAction; meta: SkillMeta }
  | { engine: 'profile'; delta?: ProfileDelta; meta: SkillMeta };

/**
 * when-to-use 触发条件（可选）。决定 agent 在什么场景下引用该 skill；未提供 = 始终适用（兼容旧叠加）。
 * 判定为 AND：所有声明维度都命中才适用；命中维度数作为 canHandle 组合权重。
 */
export interface SkillWhen {
  /** 命中之（input 或 concept）任一即算命中该维度 */
  concepts?: string[];
  /** 当前回答信号命中任一只算命中（correct/confused/mistake/divergent） */
  signals?: AnswerSignal[];
  /** 最近历史需连续 count 个为该信号（读 ctx.history 末尾） */
  consecutive?: { signal: AnswerSignal; count: number };
  /** 画像掌握度需 < 阈值（读 profile.mastery()，仅 profile 具备该方法的侧） */
  profileMasteryLt?: number;
  /** 组合编排：互斥组 id。同组多 skill 命中时仅 canHandle 最高者执行 */
  exclusiveGroup?: string;
  /** 组合权重基值（canHandle 基础分），default 0 */
  priority?: number;
}

/** 能力策略 skill（IT9，detail.md §8.1）：一个可独立评估的策略模块 */
export interface CapabilitySkill {
  /** 唯一标识，如 'socratic.core'、'socratic.interest' */
  id: string;
  /** 目标引擎 */
  engine: SkillEngine;
  /** semver 版本 */
  version: string;
  /** 策略应用入口（同步或经 LLM） */
  apply(ctx: SkillContext): Promise<SkillResult> | SkillResult;
  /** 供反思/评测使用的中性描述 */
  describe(): SkillMeta;
  /**
   * 触发判定（when-to-use，可选）：返回 true 才在本轮参与叠加。
   * 未声明 = 始终适用（兼容旧叠加语义）。基于 concept/topic、回答信号、连续历史、画像等判定。
   */
  when?: (ctx: SkillContext) => boolean;
  /**
   * 场景契合度打分（可选，0.0+）：用于互斥组（exclusiveGroup）内多 skill 竞合时选一。
   * 未声明 = when 命中时 1。
   */
  canHandle?: (ctx: SkillContext) => number;
  /** 组合编排：互斥组 id。同组多 skill 命中时仅 canHandle 最高者执行（组合引用多个 skill 的竞合收敛） */
  exclusiveGroup?: string;
}

/** 激活配置条目（快照/评测对照用） */
export interface ActiveSkill {
  id: string;
  engine: SkillEngine;
  version: string;
  enabled: boolean;
}
