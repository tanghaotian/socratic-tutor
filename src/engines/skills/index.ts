import type { LLMProvider } from '../../providers/index.js';
import { StrategyManager } from './manager.js';
import { createSocraticCoreSkill } from './socratic/core.js';
import { createInterestSkill } from './socratic/interest.js';
import { createProfileCoreSkill } from './profile/core.js';

export * from './types.js';
export { StrategyManager } from './manager.js';
export { createSocraticCoreSkill } from './socratic/core.js';
export { createInterestSkill } from './socratic/interest.js';
export { createProfileCoreSkill } from './profile/core.js';

/**
 * 默认教学引擎 skill 组合：仅激活 socratic.core（保持旧行为）。
 * 可后续 register/enable 叠加 skill（如 createInterestSkill）。
 */
export function createSocraticManager(llm: LLMProvider): StrategyManager {
  const m = new StrategyManager();
  m.register(createSocraticCoreSkill(llm));
  return m;
}

/** 默认画像引擎 skill 组合：仅激活 profile.core（保持旧行为）。 */
export function createProfileManager(): StrategyManager {
  const m = new StrategyManager();
  m.register(createProfileCoreSkill());
  return m;
}
