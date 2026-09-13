import type { LearnerProfile } from '../profile.js';
import type { AnchorSnapshot } from './types.js';

/** 数值夹取 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 夹取到 [0, 1] */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** 夹取并取整 [min, max] */
export function clampInt(v: number, min: number, max: number): number {
  return Math.round(clamp(v, min, max));
}

/** 权重归一化（各分项 ≥0，和=1；全 0 时回退等权），保持输入键类型 */
export function normalizeWeights<T extends object>(w: T): T {
  const keys = Object.keys(w);
  const ww = w as Record<string, number>;
  const total = keys.reduce((s, k) => s + Math.max(0, ww[k] ?? 0), 0);
  if (total <= 0) {
    const each = 1 / keys.length;
    return Object.fromEntries(keys.map((k) => [k, each])) as T;
  }
  return Object.fromEntries(keys.map((k) => [k, Math.max(0, ww[k] ?? 0) / total])) as T;
}

/**
 * 把 id 安全化为「文件系统 + URL 路径均可用」的片段。
 * 计划/复盘 id 会用作 data/plans/<id>.md 文件名与 /api 下的 :id 路径参数；
 * Windows 禁止 \ / : * ? " < > | 出现在文件名中，? 和 / 也会破坏 URL，须替换。
 */
export function sanitizeId(id: string): string {
  return id
    .replace(/[\\/:*?"<>|]/g, '-')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32) // 剔除控制字符
    .join('')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * 由画像现算默认锚点（无锚定调整记录时使用）。
 * 锚点 = 对学员学习情况的假设：初始掌握度、目标深度/难度、学习速度基线、重复偏向。
 */
export function defaultAnchor(profile: LearnerProfile): AnchorSnapshot {
  const entries = Object.entries(profile.mastery);
  const initialMastery: Record<string, number> = {};
  for (const [t, m] of entries) initialMastery[t] = clamp01(m.level);
  const avg = entries.length
    ? entries.reduce((s, [, m]) => s + clamp01(m.level), 0) / entries.length
    : 0.3;
  const speed = Math.max(0.1, profile.learningSpeed || 0.5);
  return {
    initialMastery,
    targetDepth: clampInt(1 + avg * 4, 1, 5),
    targetDifficulty: clamp01(0.4 + avg * 0.4),
    learningSpeedBaseline: speed,
    repetitionBias: clampInt(3 * (1 - Math.min(1, speed)), 0, 3),
  };
}
