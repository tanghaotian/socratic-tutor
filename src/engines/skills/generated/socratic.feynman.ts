import { evaluateWhen, canHandleFor } from '../when.js';
import type { CapabilitySkill, SkillContext, SkillResult, SkillMeta, SkillWhen } from '../types.js';

/**
 * 由知识产物自动生成的能力策略 skill（§8.2.1）。
 * 来源：教学方法论资料提炼。确定性规则实现，不依赖 LLM。
 * when（when-to-use）：声明该 skill 在什么场景下才应被引用；同 exclusiveGroup 与其他 skill 竞合时由 canHandle 择优。
 */
const RULES = {
  id: 'socratic.feynman',
  version: '1.0.0',
  purpose: '通过让学习者用通俗语言复述概念来暴露理解漏洞并强化深度掌握',
  strategy: 'adaptivity',
  triggers: ["解释", "说明", "大白话", "类比", "例子", "卡壳", "听不懂", "似懂非懂"],
  phrase: '试着把 {topic} 讲给一个完全不懂的人听，你会怎么开头？',
  interestBoost: 3,
  when: { concepts: ["概念","原理","定义","机制"], signals: ["confused","mistake","divergent"], exclusiveGroup: "feynman_technique_group", priority: 8 } as SkillWhen,
};

const META: SkillMeta = { id: RULES.id, engine: 'socratic', version: RULES.version, purpose: RULES.purpose };

export function createSocraticFeynmanSkill(): CapabilitySkill {
  const gate = Object.keys(RULES.when).length > 0
    ? {
        when: (c: SkillContext) => evaluateWhen(RULES.when, c),
        canHandle: (c: SkillContext) => canHandleFor(RULES.when, c),
        exclusiveGroup: RULES.when.exclusiveGroup,
      }
    : {};
  return {
    id: RULES.id,
    engine: 'socratic',
    version: RULES.version,
    describe: () => META,
    ...gate,
    apply(ctx: SkillContext): SkillResult {
      const prev = ctx.prevAction;
      if (!prev || !('content' in prev) || !RULES.phrase) {
        return { engine: 'socratic', meta: META };
      }
      const hit = RULES.triggers.length === 0 || RULES.triggers.some((t) => ctx.input.includes(t));
      if (!hit) return { engine: 'socratic', meta: META };
      const topic = ctx.input.trim().slice(0, 24) || '这个话题';
      const content = RULES.phrase.replaceAll('{topic}', topic).trim() + prev.content;
      return { engine: 'socratic', action: { ...prev, content }, meta: META };
    },
  };
}
