import type { CapabilitySkill, SkillContext, SkillResult, SkillMeta } from '../types.js';

/**
 * 兴趣激励叠加 skill（IT9 叠加示例，默认不激活）。
 * 叠加在 socratic.core 之后：基于上一个 skill 产出的动作，在内容前追加一句
 * 激励/贴近兴趣的引导，不改变题型与提示层级。通过 enable 后可体验叠加效果。
 */
export function createInterestSkill(): CapabilitySkill {
  const meta: SkillMeta = {
    id: 'socratic.interest',
    engine: 'socratic',
    version: '0.1.0',
    purpose: '在教学动作内容上叠加兴趣激励引导（叠加于 core 之后）',
  };

  return {
    id: meta.id,
    engine: 'socratic',
    version: meta.version,
    describe: () => meta,

    apply(ctx: SkillContext): SkillResult {
      const prev = ctx.prevAction;
      if (!prev || !('content' in prev)) {
        // 无前置动作可叠加：不产出动作，仅记录
        return { engine: 'socratic', meta };
      }
      const snippet = ctx.input.trim().slice(0, 24) || '这个话题';
      const content = `我知道这不太容易，但你刚刚提到「${snippet}」，离答案已经很近了。${prev.content}`;
      return {
        engine: 'socratic',
        action: { ...prev, content },
        meta,
      };
    },
  };
}
