import type { LLMProvider } from '../../providers/index.js';
import type {
  PlanDraft,
  PlanReviewStrategy,
  PlanReviewStrategyConfig,
  ReviewDraft,
  StrategyContext,
} from './types.js';
import { createDefaultPlanStrategy, createDefaultReviewStrategy } from './default-strategy.js';
import { clamp01, clampInt } from './util.js';

/** 依据配置物化策略（LLM structuredCall + 失败回退默认启发式） */
export function createStrategyFromConfig(
  cfg: PlanReviewStrategyConfig,
  llm?: LLMProvider,
): PlanReviewStrategy {
  return cfg.kind === 'plan' ? createPlanStrategy(cfg, llm) : createReviewStrategy(cfg, llm);
}

const PLAN_SYSTEM_PROMPT = `你是学习规划助手。基于学员画像、画像锚点与目标主题，制定一份学习计划。
只输出 JSON 对象：
- goals: array，每项 {topic_id, target_level(0-1 目标掌握度), target_depth(1-5 目标深度), sessions(计划会话次数)}
- strategy: string（一句制定思路）
只输出 JSON，不要输出其他文字。`;

const REVIEW_SYSTEM_PROMPT = `你是学习复盘助手。基于学员画像、锚点、学习计划与加权评分，做一次复盘总结。
只输出 JSON 对象：
- findings: string[]（复盘发现：学得如何、偏差在哪）
- improvement_notes: string[]（后续改进建议）
只输出 JSON，不要输出其他文字。`;

interface RawPlan {
  goals?: { topic_id?: string; target_level?: number; target_depth?: number; sessions?: number }[];
  strategy?: string;
}

interface RawReview {
  findings?: string[];
  improvement_notes?: string[];
}

function createPlanStrategy(cfg: PlanReviewStrategyConfig, llm?: LLMProvider): PlanReviewStrategy {
  const fallback = createDefaultPlanStrategy();
  return {
    id: cfg.id,
    kind: 'plan',
    version: cfg.version,
    async generatePlan(ctx: StrategyContext): Promise<PlanDraft | null> {
      if (!llm) return fallback.generatePlan(ctx);
      const res = await llm.structuredCall<RawPlan>(
        PLAN_SYSTEM_PROMPT,
        buildPlanUserPrompt(ctx, cfg.planPrompt),
        {
          type: 'object',
          properties: {
            goals: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  topic_id: { type: 'string' },
                  target_level: { type: 'number' },
                  target_depth: { type: 'number' },
                  sessions: { type: 'number' },
                },
                required: ['topic_id', 'target_level', 'target_depth', 'sessions'],
              },
            },
            strategy: { type: 'string' },
          },
          required: ['goals'],
        },
      );
      if (!res.ok) return fallback.generatePlan(ctx);
      const goals = (res.data.goals ?? [])
        .map((g) => ({
          topicId: g.topic_id ?? '',
          targetLevel: clamp01(g.target_level ?? 0.5),
          targetDepth: clampInt(g.target_depth ?? ctx.anchors.targetDepth, 1, 5),
          sessions: clampInt(g.sessions ?? 1, 1, 12),
        }))
        .filter((g) => g.topicId.length > 0);
      if (goals.length === 0) return fallback.generatePlan(ctx);
      return {
        goals,
        strategy: res.data.strategy?.trim() || 'LLM 按画像与锚点定制',
        anchors: ctx.anchors,
      };
    },
    async generateReview(): Promise<ReviewDraft | null> {
      return null;
    },
    describe() {
      return { id: cfg.id, version: cfg.version, kind: 'plan' as const };
    },
  };
}

function createReviewStrategy(cfg: PlanReviewStrategyConfig, llm?: LLMProvider): PlanReviewStrategy {
  const fallback = createDefaultReviewStrategy();
  return {
    id: cfg.id,
    kind: 'review',
    version: cfg.version,
    async generatePlan(): Promise<PlanDraft | null> {
      return null;
    },
    async generateReview(ctx: StrategyContext): Promise<ReviewDraft | null> {
      if (!llm) return fallback.generateReview(ctx);
      const res = await llm.structuredCall<RawReview>(
        REVIEW_SYSTEM_PROMPT,
        buildReviewUserPrompt(ctx, cfg.reviewPrompt),
        {
          type: 'object',
          properties: {
            findings: { type: 'array', items: { type: 'string' } },
            improvement_notes: { type: 'array', items: { type: 'string' } },
          },
          required: ['findings', 'improvement_notes'],
        },
      );
      if (!res.ok) return fallback.generateReview(ctx);
      return {
        findings: res.data.findings ?? [],
        improvementNotes: res.data.improvement_notes ?? [],
      };
    },
    describe() {
      return { id: cfg.id, version: cfg.version, kind: 'review' as const };
    },
  };
}

function buildPlanUserPrompt(ctx: StrategyContext, extraPrompt?: string): string {
  const extra = extraPrompt ? `\n额外要求：${extraPrompt}` : '';
  return (
    `学员画像：${JSON.stringify({ mastery: ctx.profile.mastery, learningSpeed: ctx.profile.learningSpeed, frequency: ctx.profile.frequency })}\n` +
    `画像锚点：${JSON.stringify(ctx.anchors)}\n` +
    `目标主题：${ctx.topicId ?? '（未指定，按画像薄弱主题制定）'}` +
    extra
  );
}

function buildReviewUserPrompt(ctx: StrategyContext, extraPrompt?: string): string {
  const extra = extraPrompt ? `\n额外要求：${extraPrompt}` : '';
  return (
    `学员画像：${JSON.stringify({ mastery: ctx.profile.mastery, learningSpeed: ctx.profile.learningSpeed, frequency: ctx.profile.frequency })}\n` +
    `画像锚点：${JSON.stringify(ctx.anchors)}\n` +
    `学习计划：${JSON.stringify(ctx.previousPlan ?? {})}\n` +
    `加权评分：${JSON.stringify(ctx.scores ?? {})}` +
    extra
  );
}
