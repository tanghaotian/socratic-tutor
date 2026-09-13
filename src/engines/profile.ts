import type { AnswerSignal } from '../providers/index.js';
import type { AdaptiveProfile } from './socratic.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import {
  StrategyManager,
  createProfileManager,
  type SkillContext,
  type ProfileDelta,
} from './skills/index.js';

/** 单个知识点的掌握度 */
export interface TopicMastery {
  level: number;      // 0.0-1.0
  mistakes: string[]; // 历史错误知识点
  strengths: string[];
}

/** 学习画像（数据模型，详见 detail.md 1.1） */
export interface LearnerProfile {
  learnerId: string;
  createdAt: string;
  updatedAt: string;
  mastery: Record<string, TopicMastery>; // key=topicId
  frequency: {
    totalSessions: number;
    lastStudyDates: string[]; // 最近学习日期 (YYYY-MM-DD)
    weeklyAvg: number;        // 周均学习次数
  };
  interest: {
    topics: Record<string, number>; // 兴趣权重
    preferences: string[];
  };
  learningSpeed: number; // 自适应系数
}

/** 自适应参数（难度/深度/重复度） */
export interface AdaptiveParams {
  depth: number;       // 当前推进深度
  targetDepth: number; // 目标深度（越大越难）
  repetition: number;  // 需要重复的次数
}

const MAX_DEPTH = 5;
export const MASTERY_MIN = 0;
export const MASTERY_MAX = 1;

/**
 * 学习画像与自适应引擎（IT3，IT9 起经 StrategyManager 消费能力 skill）。
 * 每次回答后经 profile skills 推导增量（ProfileDelta），合并后落库；
 * 并据画像推导自适应参数。默认激活 `profile.core` skill，行为与旧版一致。
 */
export class ProfileEngine {
  private store: SqliteStorage;
  private manager: StrategyManager;

  constructor(store: SqliteStorage, skills?: StrategyManager) {
    this.store = store;
    this.manager = skills ?? createProfileManager();
  }

  /** 暴露当前 skill 管理器（注册/启停/快照用） */
  get skills(): StrategyManager {
    return this.manager;
  }

  /** 读取或初始化画像 */
  getOrCreate(learnerId: string): LearnerProfile {
    const existing = this.store.getProfile(learnerId);
    if (existing) return existing;
    const now = new Date();
    const profile: LearnerProfile = {
      learnerId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      mastery: {},
      frequency: { totalSessions: 0, lastStudyDates: [], weeklyAvg: 0 },
      interest: { topics: {}, preferences: [] },
      learningSpeed: 1,
    };
    this.store.saveProfile(learnerId, profile);
    return profile;
  }

  /**
   * 依据最新回答信号更新画像，并落库。
   * @returns 更新后的画像
   */
  async updateFromSignal(
    learnerId: string,
    signal: AnswerSignal,
    topicId?: string,
  ): Promise<LearnerProfile> {
    const profile = this.getOrCreate(learnerId);

    const skillCtx: SkillContext = {
      input: topicId ?? '',
      concept: topicId,
      signal: {
        signal,
        confidence: 1,
        conceptIds: topicId ? [topicId] : [],
        errorCategories: [],
      },
      history: [],
      profile,
    };
    const results = await this.manager.run('profile', skillCtx);
    for (const r of results) {
      if (r.engine === 'profile' && r.delta) applyProfileDelta(profile, r.delta);
    }

    profile.updatedAt = new Date().toISOString();
    this.store.saveProfile(learnerId, profile);
    return profile;
  }

  /** 某 topic 的历史错误次数 */
  mistakeCount(learnerId: string, topicId: string): number {
    const p = this.getOrCreate(learnerId);
    return p.mastery[topicId]?.mistakes.length ?? 0;
  }

  /** 推导自适应参数：由掌握度映射到目标深度，再生成当前推进深度与重复度 */
  adaptiveParams(learnerId: string, topicId?: string): AdaptiveParams {
    const p = this.getOrCreate(learnerId);
    const level = topicId ? p.mastery[topicId]?.level ?? 0.5 : 0.5;
    // 掌握度越高 → 目标深度越大
    const targetDepth = Math.round(level * MAX_DEPTH);
    // 当前推进深度：向 targetDepth 靠拢的稳定值（本迭代简化 = targetDepth）
    const depth = targetDepth;
    // 错误越多 → 重复次数越多
    const mistakes = topicId ? p.mastery[topicId]?.mistakes.length ?? 0 : 0;
    const repetition = mistakes > 2 ? 3 : mistakes > 0 ? 2 : 1;
    return { depth, targetDepth, repetition };
  }

  /** 适配 SocraticEngine 的最小画像契约（面向指定 topic 提供的简版） */
  toAdaptiveView(learnerId: string, topicId: string = 'default'): AdaptiveProfile {
    return {
      adjustDepth: () => this.adaptiveParams(learnerId, topicId).depth,
      mastery: () => this.getOrCreate(learnerId).mastery[topicId]?.level ?? 0.5,
    };
  }
}

/** 将多个 profile skill 产出的增量合并应用到画像（掌握度/频率/兴趣/学习速度） */
export function applyProfileDelta(profile: LearnerProfile, delta: ProfileDelta): void {
  // 1) 掌握度
  if (delta.masteryDelta) {
    for (const [topic, d] of Object.entries(delta.masteryDelta)) {
      const t = profile.mastery[topic] ?? { level: 0.5, mistakes: [], strengths: [] };
      t.level = clamp(t.level + d.levelDelta);
      if (d.strengths) {
        for (const s of d.strengths) if (!t.strengths.includes(s)) t.strengths.push(s);
      }
      if (d.mistakes) {
        for (const m of d.mistakes) t.mistakes.push(m);
      }
      profile.mastery[topic] = t;
    }
  }

  // 2) 频率：会话计数 + 学习日期
  const now = new Date();
  profile.frequency.totalSessions += delta.sessionsDelta ?? 1;
  const today = toDateKey(now);
  if (!profile.frequency.lastStudyDates.includes(today)) {
    profile.frequency.lastStudyDates.push(today);
    if (profile.frequency.lastStudyDates.length > 30) {
      profile.frequency.lastStudyDates.shift();
    }
  }
  profile.frequency.weeklyAvg = calcWeeklyAvg(profile.frequency.lastStudyDates, now);

  // 3) 兴趣：本次学习给 topic 加权
  if (delta.interestDelta) {
    for (const [topic, w] of Object.entries(delta.interestDelta)) {
      profile.interest.topics[topic] = (profile.interest.topics[topic] ?? 0) + w;
    }
  }

  // 4) 学习速度系数（下限 0.1）
  if (delta.learningSpeedDelta) {
    profile.learningSpeed = Math.max(0.1, profile.learningSpeed + delta.learningSpeedDelta);
  }
}

function clamp(v: number): number {
  return Math.min(MASTERY_MAX, Math.max(MASTERY_MIN, v));
}

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 最近 7 天内的学习天数计为周均 */
function calcWeeklyAvg(dates: string[], now: Date): number {
  if (dates.length === 0) return 0;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 7);
  const minKey = toDateKey(cutoff);
  return dates.filter((d) => d >= minKey).length;
}
