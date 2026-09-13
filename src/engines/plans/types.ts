import type { LearnerProfile } from '../profile.js';
import type { LLMProvider } from '../../providers/index.js';

/** 文档状态机：draft（待确认）→ confirmed（已确认） */
export type DocStatus = 'draft' | 'confirmed';

/** 画像锚点快照（学习计划与复盘共同引用；"锚定"= 对学员学习情况的假设） */
export interface AnchorSnapshot {
  /** 各主题初始掌握度假设（0-1） */
  initialMastery: Record<string, number>;
  /** 目标深度（1-5） */
  targetDepth: number;
  /** 目标难度（0-1） */
  targetDifficulty: number;
  /** 学习速度基线（≥0.1） */
  learningSpeedBaseline: number;
  /** 重复偏向（0-3） */
  repetitionBias: number;
}

/** 学习计划目标（按主题） */
export interface PlanGoal {
  topicId: string;
  /** 目标掌握度（0-1） */
  targetLevel: number;
  /** 目标深度（1-5） */
  targetDepth: number;
  /** 计划会话次数 */
  sessions: number;
}

/** 学习计划（data/plans/<id>.md） */
export interface StudyPlan {
  id: string;
  learnerId: string;
  period: { start: string; end: string };
  goals: PlanGoal[];
  /** 生成策略说明 */
  strategy: string;
  /** 生成时采用的锚点 */
  anchors: AnchorSnapshot;
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
  /** 生成器版本（策略 id） */
  generatorVersion?: string;
}

/** 复盘加权评分（各分项 0-1） */
export interface ReviewScore {
  goalCompletion: number;
  signalAccuracy: number;
  frequencyRate: number;
  masteryChange: number;
  /** 加权合成（0-1） */
  weighted: number;
}

/** 复盘（data/reviews/<id>.md） */
export interface StudyReview {
  id: string;
  learnerId: string;
  planId: string;
  period: { start: string; end: string };
  scores: ReviewScore;
  /** 复盘发现 */
  findings: string[];
  /** 后续建议 */
  improvementNotes: string[];
  /** 复盘时采用的锚点 */
  anchors: AnchorSnapshot;
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
  generatorVersion?: string;
}

/** 锚定调整审计（data/anchors/<reviewId>.md + SQLite） */
export interface AnchorAdjustment {
  id: string;
  learnerId: string;
  reviewId: string;
  trigger: { streak: number; threshold: number };
  before: AnchorSnapshot;
  after: AnchorSnapshot;
  method: 'llm' | 'heuristic';
  reasons: string[];
  createdAt: string;
}

/** 复盘加权评分权重（读取时 clamp 并归一化） */
export interface ReviewWeights {
  goalCompletion: number;
  signalAccuracy: number;
  frequencyRate: number;
  masteryChange: number;
}

/** 学习事件（一次回答信号，复盘评分的输入源） */
export interface LearningEvent {
  id: string;
  learnerId: string;
  topicId?: string;
  signal: 'correct' | 'mistake' | 'confused' | 'divergent' | string;
  date: string; // ISO8601
}

/** 进化评估的候选/已应用策略配置（data/plans/active.json 条目） */
export interface PlanReviewStrategyConfig {
  id: string;
  kind: 'plan' | 'review';
  version: string;
  planPrompt?: string;
  reviewPrompt?: string;
  /** 评分权重（plan 策略可携带） */
  weights?: ReviewWeights;
  heuristics?: Record<string, number>;
}

/** 策略生成上下文（由引擎组装，传入生成器） */
export interface StrategyContext {
  learnerId: string;
  profile: LearnerProfile;
  anchors: AnchorSnapshot;
  topicId?: string;
  previousPlan?: StudyPlan;
  planId?: string;
  history: { signal: string; topicId?: string; date: string }[];
  llm?: LLMProvider;
  weights: ReviewWeights;
  /** 复盘生成时预计算的加权评分（可选，启发式复盘据此给出发现） */
  scores?: ReviewScore;
}

/** 计划生成草稿 */
export interface PlanDraft {
  goals: PlanGoal[];
  strategy: string;
  anchors: AnchorSnapshot;
  degraded?: boolean;
}

/** 复盘生成草稿 */
export interface ReviewDraft {
  findings: string[];
  improvementNotes: string[];
  degraded?: boolean;
}

/** 可插拔的 plan/review 生成能力（进化评估与引擎消费的统一接口） */
export interface PlanReviewStrategy {
  readonly id: string;
  readonly kind: 'plan' | 'review';
  readonly version: string;
  /** 生成学习计划（kind=review 的策略返回 null） */
  generatePlan(ctx: StrategyContext): Promise<PlanDraft | null>;
  /** 生成复盘（kind=plan 的策略返回 null） */
  generateReview(ctx: StrategyContext): Promise<ReviewDraft | null>;
  describe(): { id: string; version: string; kind: string };
}

