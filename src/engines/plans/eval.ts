import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../../providers/index.js';
import type { LearnerProfile } from '../profile.js';
import type {
  PlanReviewStrategy,
  PlanReviewStrategyConfig,
  ReviewWeights,
  StrategyContext,
  StudyPlan,
} from './types.js';
import { createStrategyFromConfig } from './llm-strategy.js';
import { createDefaultPlanStrategy, createDefaultReviewStrategy } from './default-strategy.js';
import { defaultAnchor, normalizeWeights, clamp01, clamp } from './util.js';
import { computeReviewScore, DEFAULT_REVIEW_WEIGHTS } from './scoring.js';

/** 评测输入线程（兼容 eval/types 的冻结线程形态） */
export interface StrategyEvalThread {
  id: string;
  topic: string;
  turns: { role: string; content: string; signal?: string }[];
}

export interface StrategyEvalOptions {
  /** 当前组合（plan + review 各一条） */
  baseline: PlanReviewStrategyConfig[];
  /** 候选组合 */
  candidate: PlanReviewStrategyConfig[];
  threads: StrategyEvalThread[];
  profileSamples?: LearnerProfile[];
  judgeProvider?: LLMProvider;
  /** 报告落盘根目录（data/evals/<date>_strategy.json） */
  outputDir: string;
  /** 组合权重（默认 plan 0.5 + review 0.5） */
  planWeight?: number;
  reviewWeight?: number;
  /** 达标线（默认 6） */
  minScore?: number;
}

export type StrategyVerdict = 'accepted' | 'rejected' | 'needs_review';

export interface StrategyEvalReport {
  date: string;
  threads: number;
  planScore: { baseline: number; candidate: number };
  reviewScore: { baseline: number; candidate: number };
  combined: { baseline: number; candidate: number };
  verdict: StrategyVerdict;
  judgeDegraded: boolean;
  reasons: string[];
}

const JUDGE_SYSTEM_PROMPT = `你是教育能力评测裁判。给定学习计划文档与复盘文档，从两个维度打分（各 0-10）：
- plan_quality: 计划目标是否合理、难度是否适配学员、是否可执行
- review_quality: 复盘分析深度、评分是否合理、建议是否可操作
只输出 JSON 对象 {plan_quality, review_quality}，只输出 JSON。`;

interface JudgeScore {
  plan: number;
  review: number;
  degraded: boolean;
}

/**
 * 组合加权评测（进化门禁）：
 * 对 baseline/candidate 两套 plan+review 策略，用冻结线程重放生成计划与复盘文档，
 * LLM-as-Judge 按 planQuality/reviewQuality 两维打分 → 加权合成 → A/B 判定。
 * judge 缺失/失败 → 启发式同分 + judgeDegraded → 一律 needs_review（不自动应用）。
 */
export async function runStrategyEval(opts: StrategyEvalOptions): Promise<StrategyEvalReport> {
  const planW = opts.planWeight ?? 0.5;
  const reviewW = opts.reviewWeight ?? 0.5;
  const minScore = opts.minScore ?? 6;
  const baselinePair = buildPair(opts.baseline, opts.judgeProvider);
  const candidatePair = buildPair(opts.candidate, opts.judgeProvider);

  const dims = {
    plan: { baseline: [] as number[], candidate: [] as number[] },
    review: { baseline: [] as number[], candidate: [] as number[] },
  };
  let degraded = false;

  const samples = opts.profileSamples ?? [];
  for (let i = 0; i < opts.threads.length; i++) {
    const thread = opts.threads[i];
    const profile = samples[i % Math.max(1, samples.length)] ?? stubProfile(thread);

    const b = await generateSide(baselinePair, thread, profile, i);
    const c = await generateSide(candidatePair, thread, profile, i);

    const bj = await scoreOne(opts.judgeProvider, b.planDoc, b.reviewDoc);
    const cj = await scoreOne(opts.judgeProvider, c.planDoc, c.reviewDoc);
    if (bj.degraded || cj.degraded) degraded = true;

    dims.plan.baseline.push(bj.plan);
    dims.plan.candidate.push(cj.plan);
    dims.review.baseline.push(bj.review);
    dims.review.candidate.push(cj.review);
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const planScore = { baseline: avg(dims.plan.baseline), candidate: avg(dims.plan.candidate) };
  const reviewScore = { baseline: avg(dims.review.baseline), candidate: avg(dims.review.candidate) };
  const combined = {
    baseline: planW * planScore.baseline + reviewW * reviewScore.baseline,
    candidate: planW * planScore.candidate + reviewW * reviewScore.candidate,
  };

  let verdict: StrategyVerdict;
  const reasons: string[] = [];
  if (degraded) {
    verdict = 'needs_review';
    reasons.push('judge 不可用（降级启发式打分），不自动应用，待人工复核');
  } else if (combined.candidate < minScore) {
    verdict = 'rejected';
    reasons.push(`候选组合综合分 ${combined.candidate.toFixed(2)} 低于达标线 ${minScore}`);
  } else if (combined.candidate > combined.baseline) {
    verdict = 'accepted';
    reasons.push(
      `候选组合综合分 ${combined.candidate.toFixed(2)} 高于当前 ${combined.baseline.toFixed(2)}（plan ${planScore.candidate.toFixed(2)} vs ${planScore.baseline.toFixed(2)}，review ${reviewScore.candidate.toFixed(2)} vs ${reviewScore.baseline.toFixed(2)}）`,
    );
  } else {
    verdict = 'needs_review';
    reasons.push('候选达标但未产生提升，需人工判断是否采纳');
  }

  const report: StrategyEvalReport = {
    date: new Date().toISOString(),
    threads: opts.threads.length,
    planScore,
    reviewScore,
    combined,
    verdict,
    judgeDegraded: degraded,
    reasons,
  };
  persistReport(report, opts.outputDir);
  return report;
}

/** 读取已应用策略注册表（data/plans/active.json） */
export function readActiveStrategies(dir: string): PlanReviewStrategyConfig[] {
  const file = path.join(dir, 'plans', 'active.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as PlanReviewStrategyConfig[];
  } catch {
    return [];
  }
}

/** 应用策略（幂等：同 kind+id 覆盖） */
export function applyStrategy(cfg: PlanReviewStrategyConfig, dir: string): PlanReviewStrategyConfig {
  const list = readActiveStrategies(dir).filter((c) => c.kind !== cfg.kind || c.id !== cfg.id);
  list.push(cfg);
  const file = path.join(dir, 'plans', 'active.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
  return cfg;
}

export function listActiveStrategies(dir: string): PlanReviewStrategyConfig[] {
  return readActiveStrategies(dir);
}

/** 装配：默认组合 + 已应用策略（kind=plan/review 各取一条） */
export function createStrategyManagerFromRegistry(
  dir: string,
  llm?: LLMProvider,
): { plan: PlanReviewStrategy; review: PlanReviewStrategy } {
  const cfgs = readActiveStrategies(dir);
  const planCfg = cfgs.find((c) => c.kind === 'plan');
  const reviewCfg = cfgs.find((c) => c.kind === 'review');
  return {
    plan: planCfg ? createStrategyFromConfig(planCfg, llm) : createDefaultPlanStrategy(),
    review: reviewCfg ? createStrategyFromConfig(reviewCfg, llm) : createDefaultReviewStrategy(),
  };
}

// ---- 内部 ----

function buildPair(
  cfgs: PlanReviewStrategyConfig[],
  llm?: LLMProvider,
): { plan: PlanReviewStrategy; review: PlanReviewStrategy } {
  const planCfg = cfgs.find((c) => c.kind === 'plan');
  const reviewCfg = cfgs.find((c) => c.kind === 'review');
  return {
    plan: planCfg ? createStrategyFromConfig(planCfg, llm) : createDefaultPlanStrategy(),
    review: reviewCfg ? createStrategyFromConfig(reviewCfg, llm) : createDefaultReviewStrategy(),
  };
}

async function generateSide(
  pair: { plan: PlanReviewStrategy; review: PlanReviewStrategy },
  thread: StrategyEvalThread,
  profile: LearnerProfile,
  index: number,
): Promise<{ planDoc: string; reviewDoc: string }> {
  const anchors = defaultAnchor(profile);
  const weights = normalizeWeights(DEFAULT_REVIEW_WEIGHTS) as ReviewWeights;
  const ctx: StrategyContext = {
    learnerId: 'eval',
    profile,
    anchors,
    topicId: thread.topic,
    history: [],
    weights,
  };
  const planDraft = await pair.plan.generatePlan(ctx);
  if (!planDraft) throw new Error(`计划生成失败: ${thread.topic}`);
  const plan: StudyPlan = {
    id: `eval-${index}`,
    learnerId: 'eval',
    period: { start: '2026-01-01', end: '2026-01-08' },
    goals: planDraft.goals,
    strategy: planDraft.strategy,
    anchors: planDraft.anchors,
    status: 'draft',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    generatorVersion: pair.plan.describe().id,
  };
  const events = thread.turns.map((t, i) => ({
    id: `ev-${index}-${i}`,
    learnerId: 'eval',
    topicId: thread.topic,
    signal: t.signal ?? 'correct',
    date: '2026-01-02',
  }));
  const scores = computeReviewScore(profile, plan, events, DEFAULT_REVIEW_WEIGHTS);
  const reviewDraft = await pair.review.generateReview({
    ...ctx,
    planId: plan.id,
    previousPlan: plan,
    scores,
    history: events.map((e) => ({ signal: e.signal, topicId: e.topicId, date: e.date })),
  });

  const planDoc =
    `# 学习计划（${pair.plan.describe().id}）\n` +
    `学员画像：${JSON.stringify(profile)}\n` +
    `目标：${JSON.stringify(planDraft.goals)}\n` +
    `策略：${planDraft.strategy}`;
  const reviewDoc =
    `# 复盘（${pair.review.describe().id}）\n` +
    `加权评分：${JSON.stringify(scores)}\n` +
    `发现：${JSON.stringify(reviewDraft?.findings ?? [])}\n` +
    `建议：${JSON.stringify(reviewDraft?.improvementNotes ?? [])}`;
  return { planDoc, reviewDoc };
}

async function scoreOne(
  judge: LLMProvider | undefined,
  planDoc: string,
  reviewDoc: string,
): Promise<JudgeScore> {
  if (!judge) return { plan: 6, review: 6, degraded: true };
  const res = await judge.structuredCall<{ plan_quality?: number; review_quality?: number }>(
    JUDGE_SYSTEM_PROMPT,
    `学习计划文档：\n${planDoc}\n\n复盘文档：\n${reviewDoc}`,
    {
      type: 'object',
      properties: {
        plan_quality: { type: 'number' },
        review_quality: { type: 'number' },
      },
      required: ['plan_quality', 'review_quality'],
    },
  );
  if (!res.ok) return { plan: 6, review: 6, degraded: true };
  return {
    plan: clamp(res.data.plan_quality ?? 6, 0, 10),
    review: clamp(res.data.review_quality ?? 6, 0, 10),
    degraded: false,
  };
}

function stubProfile(thread: StrategyEvalThread): LearnerProfile {
  return {
    learnerId: 'eval',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    mastery: { [thread.topic]: { level: 0.3, mistakes: [], strengths: [] } },
    frequency: { totalSessions: 1, lastStudyDates: ['2026-01-02'], weeklyAvg: 1 },
    interest: { topics: {}, preferences: [] },
    learningSpeed: 0.6,
  };
}

function persistReport(report: StrategyEvalReport, outputDir: string): void {
  const evalsDir = path.join(outputDir, 'evals');
  fs.mkdirSync(evalsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(evalsDir, `${date}_strategy.json`);
  fs.writeFileSync(file, JSON.stringify({ ...report, file }, null, 2), 'utf-8');
  void clamp01; // 保留 util 引用
}
