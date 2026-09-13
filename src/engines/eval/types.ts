import type { LLMProvider, AnswerSignal } from '../../providers/index.js';
import type { ActiveSkill } from '../skills/index.js';

/** 目标引擎 */
export type EvalEngine = 'socratic' | 'profile';

/** 引擎快照：某版本激活 skill 组合（IT9 snapshot 产物）+ 可选预存基线分 */
export interface EngineSnapshot {
  label: string; // 'baseline' | 'candidate' | 任意描述
  activeSkills: ActiveSkill[];
  /** 预存基线分（可选，避免每次全量重跑 baseline） */
  baselineScore?: Record<string, number>;
}

/** 冻结的历史对话线程（每周抽样/每月全量重放源） */
export interface FrozenThread {
  id: string;
  topic?: string;
  turns: { role: 'user' | 'agent'; content: string; signal?: AnswerSignal }[];
}

/** 单条评测维度 */
export interface RubricDimension {
  id: string;
  label: string;
  weight: number; // 0-1，参与加权 delta
  core: boolean;  // 核心维：任一回退即 rejected（NDAR 不可回退）
}

export interface Rubric {
  dimensions: RubricDimension[];
}

/** 引擎观测（一次重放的产出），供 judge 打分 */
export interface EngineObservation {
  /** 每轮引擎产出文本（socratic 侧为引导语/反馈） */
  texts: string[];
  /** 整线程观测摘要（profile 侧为画像状态摘要） */
  summary: string;
}

/**
 * 快照重放器：用给定激活 skills 构造引擎并重放一条冻结线程，产出观测。
 * 由 reflection-gate 装配（依赖引擎/skill 工厂），eval 后端与引擎解耦。
 */
export interface SnapshotRunner {
  run(activeSkills: ActiveSkill[], thread: FrozenThread): Promise<EngineObservation>;
}

export interface EvalRequest {
  engine: EvalEngine;
  baselineSnapshot: EngineSnapshot;
  candidateSnapshot: EngineSnapshot;
  threads: FrozenThread[];
  rubric?: Rubric;
  /** 裁判模型（可独立于主讲模型） */
  judgeProvider: LLMProvider;
  /** 快照重放器（默认 self-built 后端用；外部框架后端可忽略） */
  runner?: SnapshotRunner;
  /** 全量数（每月）或抽样数（每周），缺省 = threads.length */
  sampledFrom?: number;
}

export interface DimensionScore {
  baseline: number; // 0-10
  candidate: number;
  delta: number;
}

export type Verdict = 'accepted' | 'rejected' | 'needs_review';

export interface EvalReport {
  id: string;
  engine: EvalEngine;
  created: string;
  metrics: {
    rubric: Record<string, DimensionScore>;
    abWinRate: { candidateWins: number; baselineWins: number; ties: number; winRateDelta: number };
    behavior?: { asserted: boolean; violations: string[] };
  };
  verdict: Verdict;
  /** 判定说明（供人工拦截参考） */
  reasons: string[];
  /** 是否为降级 judge（无裁判 LLM 时启发式打分） */
  judgeDegraded: boolean;
  threadsReplayed: number;
  sampledFrom: number; // 全量数（每月）或抽样数（每周）
  /** 外部后端占位说明（非 self-built 时） */
  backendNote?: string;
}
