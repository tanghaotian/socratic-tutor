import type { LLMProvider } from '../../providers/index.js';
import type { SqliteStorage } from '../../storage/sqlite.js';
import type { ProfileEngine } from '../profile.js';
import type {
  AnchorSnapshot,
  PlanReviewStrategy,
  ReviewWeights,
  StrategyContext,
  StudyPlan,
} from './types.js';
import { createDefaultPlanStrategy } from './default-strategy.js';
import { defaultAnchor, normalizeWeights, sanitizeId } from './util.js';
import { latestAnchor } from './anchor.js';
import { DEFAULT_REVIEW_WEIGHTS } from './scoring.js';

export interface StudyPlanEngineOptions {
  /** md 落盘根目录（data） */
  outputDir: string;
  /** 计划周期天数（默认 7） */
  periodDays?: number;
  /** 可缺省 → 默认启发式策略 */
  llm?: LLMProvider;
  /** 可注入策略（默认 plans.default；装配层可传 active 策略） */
  strategy?: PlanReviewStrategy;
  weights?: ReviewWeights;
}

/**
 * 学习计划引擎（0.4.0）：按主题生成学习计划 → 持久化 + data/plans/<id>.md → draft→confirmed。
 * 沿用反思引擎的幂等/状态机骨架；LLM 失败时回退默认启发式策略。
 */
export class StudyPlanEngine {
  constructor(
    private store: SqliteStorage,
    private profileEngine: ProfileEngine,
  ) {}

  async run(
    learnerId: string,
    topicId: string,
    opts: StudyPlanEngineOptions,
  ): Promise<{ plan: StudyPlan; markdownPath: string }> {
    const id = buildPlanId(learnerId, topicId, new Date());
    const existing = this.store.getStudyPlan(id);
    if (existing) {
      const md = this.store.exportPlanMarkdown(existing, opts.outputDir);
      return { plan: existing, markdownPath: md };
    }

    const profile = this.profileEngine.getOrCreate(learnerId);
    const anchors: AnchorSnapshot = latestAnchor(this.store, learnerId) ?? defaultAnchor(profile);
    const weights = normalizeWeights(opts.weights ?? DEFAULT_REVIEW_WEIGHTS) as ReviewWeights;
    const strategy = opts.strategy ?? createDefaultPlanStrategy();
    const ctx: StrategyContext = {
      learnerId,
      profile,
      anchors,
      topicId,
      history: [],
      weights,
      llm: opts.llm,
    };
    const draft = await strategy.generatePlan(ctx);
    if (!draft || draft.goals.length === 0) {
      throw new Error(`学习计划生成失败: ${topicId}`);
    }

    const now = new Date().toISOString();
    const end = new Date(Date.now() + (opts.periodDays ?? 7) * 86_400_000).toISOString();
    const plan: StudyPlan = {
      id,
      learnerId,
      period: { start: now, end },
      goals: draft.goals,
      strategy: draft.strategy,
      anchors: draft.anchors,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      generatorVersion: strategy.describe().id,
    };
    this.store.saveStudyPlan(id, plan);
    const markdownPath = this.store.exportPlanMarkdown(plan, opts.outputDir);
    return { plan, markdownPath };
  }

  /** 用户确认：draft → confirmed */
  confirm(id: string): StudyPlan {
    const plan = this.store.getStudyPlan(id);
    if (!plan) throw new Error(`学习计划不存在: ${id}`);
    if (plan.status !== 'draft') throw new Error(`仅 draft 状态可确认，当前为 ${plan.status}`);
    plan.status = 'confirmed';
    plan.updatedAt = new Date().toISOString();
    this.store.saveStudyPlan(id, plan);
    return plan;
  }

  /** 最新计划（草稿优先） */
  latest(): StudyPlan | null {
    return this.store.listStudyPlans()[0] ?? null;
  }
}

/** 计划 id：按日期 + learner + topic 幂等（同批不重复生成） */
export function buildPlanId(learnerId: string, topicId: string, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}-${learnerId}-${sanitizeId(topicId)}`;
}
