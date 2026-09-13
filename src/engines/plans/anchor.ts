import type { SqliteStorage } from '../../storage/sqlite.js';
import type { LLMProvider } from '../../providers/index.js';
import type { LearnerProfile } from '../profile.js';
import type { AnchorAdjustment, AnchorSnapshot, StudyReview } from './types.js';
import { defaultAnchor, clamp01, clampInt } from './util.js';

/** 当前锚点 = 最近一次调整的 after；无记录则由画像现算 */
export function latestAnchor(store: SqliteStorage, learnerId: string): AnchorSnapshot | null {
  const list = store.listAnchorAdjustments().filter((a) => a.learnerId === learnerId);
  return list[0]?.after ?? null;
}

/** 连续 streak 次复盘加权分 < threshold 即触发锚定反思 */
export function checkAnchorTrigger(
  store: SqliteStorage,
  learnerId: string,
  streak: number,
  threshold: number,
): boolean {
  const reviews = store.listReviews().filter((r) => r.learnerId === learnerId);
  if (reviews.length < streak) return false;
  return reviews.slice(0, streak).every((r) => r.scores.weighted < threshold);
}

export interface AnchorAdjustOptions {
  /** 连续不理想次数阈值（默认 2） */
  streak: number;
  /** 加权分阈值（默认 0.5） */
  threshold: number;
  llm?: LLMProvider;
  /** md 落盘根目录（data） */
  outputDir: string;
}

const ANCHOR_SYSTEM_PROMPT = `你是学习画像锚定诊断助手。学员画像与画像锚点已给出，且最近多次复盘加权评分不理想。
请判断对学员学习情况的"锚定假设"是否有误，并给出修正后的锚点。
只输出 JSON 对象：
- initial_mastery: object（各主题初始掌握度假设 0-1）
- target_depth: number（目标深度 1-5）
- target_difficulty: number（目标难度 0-1）
- learning_speed_baseline: number（学习速度基线 ≥0.1）
- repetition_bias: number（重复偏向 0-3）
- reasons: string[]（错位原因与修正依据，2-5 条）
只输出 JSON，不要输出其他文字。`;

interface RawAnchor {
  initial_mastery?: Record<string, number>;
  target_depth?: number;
  target_difficulty?: number;
  learning_speed_baseline?: number;
  repetition_bias?: number;
  reasons?: string[];
}

function buildAnchorUserPrompt(
  profile: LearnerProfile,
  before: AnchorSnapshot,
  reviews: StudyReview[],
): string {
  return (
    `学员画像：${JSON.stringify({ mastery: profile.mastery, learningSpeed: profile.learningSpeed, frequency: profile.frequency })}\n` +
    `当前锚点：${JSON.stringify(before)}\n` +
    `最近复盘（加权分与发现）：${JSON.stringify(reviews.map((r) => ({ weighted: r.scores.weighted, findings: r.findings })))}`
  );
}

/**
 * 锚定反思 + 自动修正：LLM 分析锚点是否有误并输出新锚点；LLM 失败/未配置时启发式降级。
 * 触发条件不满足返回 null。落 SQLite 审计 + data/anchors/<reviewId>.md。
 */
export async function adjustAnchors(
  store: SqliteStorage,
  learnerId: string,
  reviewId: string,
  opts: AnchorAdjustOptions,
): Promise<AnchorAdjustment | null> {
  if (!checkAnchorTrigger(store, learnerId, opts.streak, opts.threshold)) return null;
  const profile = store.getProfile(learnerId);
  if (!profile) return null;
  const before = latestAnchor(store, learnerId) ?? defaultAnchor(profile);
  const reviews = store
    .listReviews()
    .filter((r) => r.learnerId === learnerId)
    .slice(0, 2);

  let after: AnchorSnapshot | null = null;
  let reasons: string[] = [];
  let method: 'llm' | 'heuristic' = 'heuristic';

  if (opts.llm) {
    const res = await opts.llm.structuredCall<RawAnchor>(
      ANCHOR_SYSTEM_PROMPT,
      buildAnchorUserPrompt(profile, before, reviews),
      {
        type: 'object',
        properties: {
          initial_mastery: { type: 'object', additionalProperties: { type: 'number' } },
          target_depth: { type: 'number' },
          target_difficulty: { type: 'number' },
          learning_speed_baseline: { type: 'number' },
          repetition_bias: { type: 'number' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'initial_mastery',
          'target_depth',
          'target_difficulty',
          'learning_speed_baseline',
          'repetition_bias',
          'reasons',
        ],
      },
    );
    if (res.ok) {
      const d = res.data;
      after = {
        initialMastery: sanitizeMasteryMap(d.initial_mastery ?? {}),
        targetDepth: clampInt(d.target_depth ?? before.targetDepth, 1, 5),
        targetDifficulty: clamp01(d.target_difficulty ?? before.targetDifficulty),
        learningSpeedBaseline: Math.max(0.1, d.learning_speed_baseline ?? before.learningSpeedBaseline),
        repetitionBias: clampInt(d.repetition_bias ?? before.repetitionBias, 0, 3),
      };
      reasons = Array.isArray(d.reasons) ? d.reasons.slice(0, 8) : [];
      method = 'llm';
    }
  }

  if (!after) {
    // 启发式降级：锚点贴合实际观察（掌握度照实、难度/速度回落、重复偏向随正确率提高）
    const initialMastery: Record<string, number> = {};
    for (const [t, m] of Object.entries(profile.mastery)) initialMastery[t] = clamp01(m.level);
    const avgCorrect = reviews.length
      ? reviews.reduce((s, r) => s + r.scores.signalAccuracy, 0) / reviews.length
      : 0.5;
    after = {
      initialMastery,
      targetDepth: clampInt((before.targetDepth + 1) / 2, 1, 5),
      targetDifficulty: clamp01(before.targetDifficulty * 0.8),
      learningSpeedBaseline: Math.max(0.1, before.learningSpeedBaseline * 0.9),
      repetitionBias: clampInt(3 * (1 - Math.min(1, avgCorrect)), 0, 3),
    };
    reasons = [
      '连续多周期加权评分不理想，按实际掌握度与正确率回写锚点（启发式降级）。',
      `目标难度下调至 ${after.targetDifficulty.toFixed(2)}，学习速度基线下调至 ${after.learningSpeedBaseline.toFixed(2)}。`,
    ];
  }

  const adjustment: AnchorAdjustment = {
    id: `anchor-${reviewId}`,
    learnerId,
    reviewId,
    trigger: { streak: opts.streak, threshold: opts.threshold },
    before,
    after,
    method,
    reasons,
    createdAt: new Date().toISOString(),
  };
  store.saveAnchorAdjustment(adjustment);
  store.exportAnchorMarkdown(adjustment, opts.outputDir);
  return adjustment;
}

function sanitizeMasteryMap(m: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'number') out[k] = clamp01(v);
  }
  return out;
}
