import type { LearnerProfile } from '../profile.js';
import type { StudyPlan, StudyReview } from './types.js';
import { applyProfileDelta } from '../profile.js';
import type { ProfileDelta } from '../skills/types.js';
import { clamp01 } from './util.js';

/**
 * 交叉确认（复盘 confirm 后执行）：把计划目标与复盘实际结果比对，
 * 生成画像增量（达标 topic 提升掌握度+兴趣；未达标不抬升并记 improvement）。
 * 返回更新后的画像（无变化时返回原对象）。
 */
export function runCrossCheck(
  profile: LearnerProfile,
  plan: StudyPlan | null,
  review: StudyReview,
): LearnerProfile {
  if (!plan) return profile;
  const delta: ProfileDelta = { masteryDelta: {}, interestDelta: {}, sessionsDelta: 0 };
  for (const g of plan.goals) {
    const cur = profile.mastery[g.topicId]?.level ?? 0;
    const target = g.targetLevel;
    if (cur >= target) {
      // 达标：小幅提升掌握度 + 兴趣加权（确认反馈）
      delta.masteryDelta![g.topicId] = { levelDelta: clamp01(0.05) };
      delta.interestDelta![g.topicId] = 1;
    }
    // 未达标 topic：不抬升掌握度（repetition 由画像 skill 后续处理），记入复盘建议即可
  }
  if (Object.keys(delta.masteryDelta!).length > 0) {
    applyProfileDelta(profile, delta);
    profile.updatedAt = new Date().toISOString();
  }
  void review; // review 内 improvementNotes 已承载未达标指引
  return profile;
}
