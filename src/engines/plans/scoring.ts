import type { LearnerProfile } from '../profile.js';
import type { StudyPlan, LearningEvent, ReviewScore, ReviewWeights } from './types.js';
import { clamp01, normalizeWeights } from './util.js';

/** 默认复盘加权权重（可经 config.plan.reviewWeights 覆盖） */
export const DEFAULT_REVIEW_WEIGHTS: ReviewWeights = {
  goalCompletion: 0.4,
  signalAccuracy: 0.2,
  frequencyRate: 0.2,
  masteryChange: 0.2,
};

/**
 * 复盘加权评分（纯确定性，可单测复现）。
 * weighted = w1*goalCompletion + w2*signalAccuracy + w3*frequencyRate + w4*masteryChange
 * - goalCompletion：计划目标 topic 中当前掌握度 ≥ targetLevel 的比例
 * - signalAccuracy：周期内 correct/(correct+mistake+confused)（无信号时中性 0.5）
 * - frequencyRate：实际学习事件数 / 计划 sessions 和，上限 1
 * - masteryChange：各目标 Δlevel/(targetLevel−initial) 的均值（下限 0、上限 1）
 */
export function computeReviewScore(
  profile: LearnerProfile,
  plan: StudyPlan,
  events: LearningEvent[],
  weights?: ReviewWeights,
): ReviewScore {
  const w = normalizeWeights(weights ?? DEFAULT_REVIEW_WEIGHTS) as ReviewWeights;
  const goals = plan.goals;

  // 1) 目标完成率
  const completed = goals.filter(
    (g) => (profile.mastery[g.topicId]?.level ?? 0) >= g.targetLevel,
  ).length;
  const goalCompletion = goals.length ? completed / goals.length : 0;

  // 2) 信号正确率（仅统计计划内主题的周期信号）
  const sig = events.filter((e) => e.topicId && goals.some((g) => g.topicId === e.topicId));
  const correct = sig.filter((e) => e.signal === 'correct').length;
  const wrong = sig.filter((e) => e.signal === 'mistake' || e.signal === 'confused').length;
  const signalAccuracy = correct + wrong > 0 ? correct / (correct + wrong) : 0.5;

  // 3) 频率达成率
  const planned = goals.reduce((s, g) => s + g.sessions, 0);
  const frequencyRate = planned > 0 ? Math.min(1, events.length / planned) : 1;

  // 4) 掌握度变化（相对计划锚定的初始掌握度）
  const deltas = goals.map((g) => {
    const init = plan.anchors.initialMastery[g.topicId] ?? 0;
    const cur = profile.mastery[g.topicId]?.level ?? init;
    const span = Math.max(0.05, g.targetLevel - init);
    return Math.max(0, Math.min(1, (cur - init) / span));
  });
  const masteryChange = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0;

  const weighted = clamp01(
    w.goalCompletion * goalCompletion +
      w.signalAccuracy * signalAccuracy +
      w.frequencyRate * frequencyRate +
      w.masteryChange * masteryChange,
  );

  return {
    goalCompletion: clamp01(goalCompletion),
    signalAccuracy: clamp01(signalAccuracy),
    frequencyRate: clamp01(frequencyRate),
    masteryChange: clamp01(masteryChange),
    weighted,
  };
}
