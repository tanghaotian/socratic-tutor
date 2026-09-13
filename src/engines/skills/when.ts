import type { SkillContext, SkillWhen } from './types.js';
import type { AnswerSignal } from '../../providers/index.js';

/**
 * when-to-use 判定（IT10c 产物增强）。
 * 供运行时（createSkillFromRules）与生成码（buildSkillCode 内联等价文本）共同复用，
 * 保证两种实例的触发/组合行为一致。
 */

/** 计算 when 各维度命中情况：all=AND 全命中；count=命中维度数；total=声明维度数 */
export function matchWhen(
  w: SkillWhen | undefined,
  ctx: SkillContext,
): { all: boolean; count: number; total: number } {
  if (!w) return { all: true, count: 0, total: 0 };
  const dims: boolean[] = [];
  if (w.concepts?.length) dims.push(conceptsHit(w.concepts, ctx));
  if (w.signals?.length) dims.push(signalsHit(w.signals, ctx));
  if (w.consecutive) dims.push(consecutiveHit(w.consecutive, ctx));
  if (typeof w.profileMasteryLt === 'number') dims.push(masteryHit(w.profileMasteryLt, ctx));
  if (dims.length === 0) return { all: true, count: 0, total: 0 };
  const count = dims.filter(Boolean).length;
  return { all: count === dims.length, count, total: dims.length };
}

/** when 判定入口：该 skill 是否应在本轮参与叠加 */
export function evaluateWhen(w: SkillWhen | undefined, ctx: SkillContext): boolean {
  return matchWhen(w, ctx).all;
}

/** 场景契合度：priority 基值 + 命中维度数（互斥组内选一用） */
export function canHandleFor(w: SkillWhen | undefined, ctx: SkillContext): number {
  if (!w) return 1;
  const { count } = matchWhen(w, ctx);
  return (w.priority ?? 0) + count;
}

/** 命中之（concept 或 input）含任一概念 */
function conceptsHit(concepts: string[], ctx: SkillContext): boolean {
  const hay = `${ctx.concept ?? ''} ${ctx.input}`;
  return concepts.some((c) => hay.includes(c));
}

/** 当前回答信号命中任一生效信号 */
function signalsHit(signals: SkillWhen['signals'], ctx: SkillContext): boolean {
  const sig = ctx.signal?.signal;
  if (!sig || !signals) return false;
  return signals.some((s) => s === sig);
}

/** 最近 history 末尾需连续 count 个为该信号 */
function consecutiveHit(
  c: { signal: AnswerSignal; count: number },
  ctx: SkillContext,
): boolean {
  const h = ctx.history ?? [];
  if (h.length < c.count) return false;
  for (let i = h.length - 1; i >= h.length - c.count; i--) {
    if (h[i] !== c.signal) return false;
  }
  return true;
}

/** 画像掌握度需低于阈值（profile 需具备 mastery()，如 AdaptiveProfile） */
function masteryHit(lt: number, ctx: SkillContext): boolean {
  const p = ctx.profile as { mastery?: () => number };
  if (typeof p?.mastery !== 'function') return false;
  return p.mastery() < lt;
}