import type { LLMProvider } from '../../providers/index.js';
import type { SqliteStorage } from '../../storage/sqlite.js';
import type { ProfileEngine } from '../profile.js';
import type {
  AnchorAdjustment,
  AnchorSnapshot,
  PlanReviewStrategy,
  ReviewWeights,
  StrategyContext,
  StudyReview,
} from './types.js';
import { createDefaultReviewStrategy } from './default-strategy.js';
import { defaultAnchor, normalizeWeights, sanitizeId } from './util.js';
import { latestAnchor, adjustAnchors } from './anchor.js';
import { computeReviewScore, DEFAULT_REVIEW_WEIGHTS } from './scoring.js';
import { runCrossCheck } from './crosscheck.js';

export interface ReviewEngineOptions {
  /** md 落盘根目录（data） */
  outputDir: string;
  /** 可缺省 → 默认启发式策略 */
  llm?: LLMProvider;
  /** 可注入策略（默认 reviews.default；装配层可传 active 策略） */
  strategy?: PlanReviewStrategy;
  weights?: ReviewWeights;
  /** 锚定触发：连续不理想次数（默认 2） */
  anchorStreak?: number;
  /** 锚定触发：加权分阈值（默认 0.5） */
  anchorThreshold?: number;
}

export interface ReviewConfirmResult {
  review: StudyReview;
  anchorAdjustment: AnchorAdjustment | null;
}

/**
 * 复盘引擎（0.4.0）：计划周期结束时按加权评分生成复盘 → data/reviews/<id>.md → draft→confirmed。
 * confirm 后触发交叉确认（画像增量）与锚定反思（连续低分自动修正 + 审计）。
 */
export class ReviewEngine {
  constructor(
    private store: SqliteStorage,
    private profileEngine: ProfileEngine,
  ) {}

  async run(
    learnerId: string,
    planId: string,
    opts: ReviewEngineOptions,
  ): Promise<{ review: StudyReview; markdownPath: string }> {
    const plan = this.store.getStudyPlan(planId);
    if (!plan) throw new Error(`学习计划不存在: ${planId}`);
    const id = buildReviewId(planId, new Date());
    const existing = this.store.getReview(id);
    if (existing) {
      const md = this.store.exportReviewMarkdown(existing, opts.outputDir);
      return { review: existing, markdownPath: md };
    }

    const profile = this.profileEngine.getOrCreate(learnerId);
    const anchors: AnchorSnapshot = latestAnchor(this.store, learnerId) ?? defaultAnchor(profile);
    const weights = normalizeWeights(opts.weights ?? DEFAULT_REVIEW_WEIGHTS) as ReviewWeights;
    const events = this.store
      .listLearningEvents(learnerId)
      .filter((e) => e.date >= plan.period.start && e.date <= plan.period.end);
    const scores = computeReviewScore(profile, plan, events, weights);
    const strategy = opts.strategy ?? createDefaultReviewStrategy();
    const ctx: StrategyContext = {
      learnerId,
      profile,
      anchors,
      planId,
      previousPlan: plan,
      history: events.map((e) => ({ signal: e.signal, topicId: e.topicId, date: e.date })),
      weights,
      scores,
      llm: opts.llm,
    };
    const draft = await strategy.generateReview(ctx);

    const now = new Date().toISOString();
    const review: StudyReview = {
      id,
      learnerId,
      planId,
      period: plan.period,
      scores,
      findings: draft?.findings ?? [],
      improvementNotes: draft?.improvementNotes ?? [],
      anchors,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      generatorVersion: strategy.describe().id,
    };
    this.store.saveReview(id, review);
    const markdownPath = this.store.exportReviewMarkdown(review, opts.outputDir);
    return { review, markdownPath };
  }

  /** 用户确认：draft → confirmed，随后交叉确认 + 锚定反思 */
  async confirm(id: string, opts: ReviewEngineOptions): Promise<ReviewConfirmResult> {
    const review = this.store.getReview(id);
    if (!review) throw new Error(`复盘不存在: ${id}`);
    if (review.status !== 'draft') throw new Error(`仅 draft 状态可确认，当前为 ${review.status}`);
    review.status = 'confirmed';
    review.updatedAt = new Date().toISOString();
    this.store.saveReview(id, review);

    // 1) 交叉确认：计划目标 ↔ 复盘结果 → 画像增量（达标抬升掌握度/兴趣）
    const plan = this.store.getStudyPlan(review.planId);
    const profile = this.profileEngine.getOrCreate(review.learnerId);
    const updated = runCrossCheck(profile, plan, review);
    this.store.saveProfile(review.learnerId, updated);

    // 2) 锚定反思：连续低分自动修正锚点 + 审计落盘
    const anchorAdjustment = await adjustAnchors(this.store, review.learnerId, review.id, {
      streak: opts.anchorStreak ?? 2,
      threshold: opts.anchorThreshold ?? 0.5,
      llm: opts.llm,
      outputDir: opts.outputDir,
    });
    return { review, anchorAdjustment };
  }

  /** 最新复盘（草稿优先） */
  latest(): StudyReview | null {
    return this.store.listReviews()[0] ?? null;
  }
}

/** 复盘 id：按日期 + plan 幂等 */
export function buildReviewId(planId: string, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}-${sanitizeId(planId)}`;
}
