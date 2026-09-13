import type { CapabilitySkill, ProfileDelta, SkillContext, SkillResult, SkillMeta } from '../types.js';
import type { LearnerProfile } from '../../profile.js';

/**
 * 学习画像核心能力 skill（IT9 默认激活）。
 * 承接 IT3 ProfileEngine.updateFromSignal 的画像增量推导：
 * 依据回答信号产出掌握度/兴趣增量（ProfileDelta），由引擎统一合并并落库。
 */
export function createProfileCoreSkill(): CapabilitySkill {
  const meta: SkillMeta = {
    id: 'profile.core',
    engine: 'profile',
    version: '0.1.0',
    purpose: '依据回答信号推导掌握度与兴趣权重增量（规则式）',
  };

  return {
    id: meta.id,
    engine: 'profile',
    version: meta.version,
    describe: () => meta,

    apply(ctx: SkillContext): SkillResult {
      const profile = ctx.profile as LearnerProfile;
      const signal = ctx.signal?.signal ?? 'correct';
      const topicId = ctx.concept;
      const delta: ProfileDelta = {};

      // 1) 掌握度增量
      if (topicId) {
        const cur = profile.mastery[topicId];
        const strengths = cur?.strengths ?? [];
        switch (signal) {
          case 'correct': {
            const masterLevel = cur?.level ?? 0.5;
            const already = strengths.includes(topicId);
            delta.masteryDelta = {
              [topicId]: {
                levelDelta: LEVEL_STEP_UP * profile.learningSpeed,
                strengths: already ? undefined : [topicId],
              },
            };
            break;
          }
          case 'mistake':
          case 'confused':
            delta.masteryDelta = {
              [topicId]: { levelDelta: -LEVEL_STEP_DOWN, mistakes: [topicId] },
            };
            break;
          case 'divergent':
            break; // 发散不升降级，兴趣另行处理
        }
        // 2) 兴趣增量：本次学习给 topic 加权；发散视为好奇心强，额外加权
        delta.interestDelta = { [topicId]: signal === 'divergent' ? 0.2 : 0.1 };
      }

      return { engine: 'profile', delta, meta };
    },
  };
}

/** mastery 提升步长 */
const LEVEL_STEP_UP = 0.15;
/** mastery 下降步长 */
const LEVEL_STEP_DOWN = 0.1;
