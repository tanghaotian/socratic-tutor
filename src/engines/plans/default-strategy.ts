import type {
  AnchorSnapshot,
  PlanDraft,
  PlanGoal,
  PlanReviewStrategy,
  ReviewDraft,
  StrategyContext,
} from './types.js';
import { clamp01, clampInt } from './util.js';

/**
 * 默认启发式 plan 策略（plans.default，kind=plan）。
 * 确定性生成：按当前掌握度提升目标、锚定深度、学习速度基线推算会话次数。
 * 是 LLM 策略失败时的兜底，也是默认组合的 core 角色。
 */
export function createDefaultPlanStrategy(): PlanReviewStrategy {
  return {
    id: 'plans.default',
    kind: 'plan',
    version: '1.0.0',
    async generatePlan(ctx: StrategyContext): Promise<PlanDraft | null> {
      const topicId = ctx.topicId;
      if (!topicId) return null;
      const level = clamp01(ctx.profile.mastery[topicId]?.level ?? 0);
      const targetLevel = clamp01(level + 0.25);
      const targetDepth = clampInt(ctx.anchors.targetDepth, 1, 5);
      const speed = Math.max(0.1, ctx.anchors.learningSpeedBaseline);
      // 会话数：与目标深度正相关、与(1-掌握度)正相关、与学习速度负相关
      const sessions = clampInt(
        (targetDepth - 1) * 0.8 + ((1 - level) * 3) / speed + 1,
        1,
        12,
      );
      const goals: PlanGoal[] = [{ topicId, targetLevel, targetDepth, sessions }];
      return {
        goals,
        strategy: '默认启发式：目标掌握度=当前+0.25，会话数按锚定深度与学习速度基线推算',
        anchors: ctx.anchors,
      };
    },
    async generateReview(): Promise<ReviewDraft | null> {
      return null; // kind=plan 不生成复盘
    },
    describe() {
      return { id: 'plans.default', version: '1.0.0', kind: 'plan' as const };
    },
  };
}

/**
 * 默认启发式 review 策略（reviews.default，kind=review）。
 * 基于预计算的加权评分（ctx.scores）确定性给出复盘发现与建议。
 */
export function createDefaultReviewStrategy(): PlanReviewStrategy {
  return {
    id: 'reviews.default',
    kind: 'review',
    version: '1.0.0',
    async generatePlan(): Promise<PlanDraft | null> {
      return null; // kind=review 不生成计划
    },
    async generateReview(ctx: StrategyContext): Promise<ReviewDraft | null> {
      const s = ctx.scores;
      if (!s) return null;
      const findings: string[] = [];
      if (s.goalCompletion < 0.5) findings.push('目标完成率偏低，多个主题未达计划掌握度');
      else if (s.goalCompletion >= 0.8) findings.push('目标基本达成，掌握度提升明显');
      if (s.signalAccuracy < 0.6) findings.push('回答正确率偏低，存在概念混淆或理解偏差');
      if (s.frequencyRate < 0.6) findings.push('学习频率未达计划，节奏偏慢');
      if (s.masteryChange < 0.3) findings.push('掌握度变化有限，可能目标设置过高或学习方式低效');
      if (findings.length === 0) findings.push('本周期各项指标正常，保持当前学习节奏');

      const notes: string[] = [];
      notes.push('对未达标主题降低目标难度，或增加重复会话次数');
      notes.push('增加针对薄弱概念的苏格拉底追问与自评练习');
      notes.push('下一周期学习计划将按本次复盘加权评分动态调整');
      return { findings, improvementNotes: notes };
    },
    describe() {
      return { id: 'reviews.default', version: '1.0.0', kind: 'review' as const };
    },
  };
}

/** 默认组合（plan + review 两能力） */
export function createDefaultStrategies(): PlanReviewStrategy[] {
  return [createDefaultPlanStrategy(), createDefaultReviewStrategy()];
}
