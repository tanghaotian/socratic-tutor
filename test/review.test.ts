import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { ProfileEngine } from '../src/engines/profile.js';
import { StudyPlanEngine } from '../src/engines/plans/study-plan.js';
import { ReviewEngine } from '../src/engines/plans/review.js';
import { computeReviewScore } from '../src/engines/plans/scoring.js';
import type { StudyPlan, StudyReview } from '../src/engines/plans/types.js';
import type { LearnerProfile } from '../src/engines/profile.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-review-'));
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const profileEngine = new ProfileEngine(store);
  return { dir, store, profileEngine };
}

function cleanup(s: { dir: string; store: SqliteStorage }) {
  s.store.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
}

/** 预置画像：指定主题掌握度 */
function seedProfile(store: SqliteStorage, topicId: string, level: number): LearnerProfile {
  const profile: LearnerProfile = {
    learnerId: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    mastery: { [topicId]: { level, mistakes: [], strengths: [] } },
    frequency: { totalSessions: 2, lastStudyDates: ['2026-09-08'], weeklyAvg: 2 },
    interest: { topics: {}, preferences: [] },
    learningSpeed: 0.6,
  };
  store.saveProfile('u1', profile);
  return profile;
}

/** 直接构造并保存一个 confirmed 计划 */
function seedPlan(store: SqliteStorage, id: string, topicId: string, targetLevel: number): StudyPlan {
  const plan: StudyPlan = {
    id,
    learnerId: 'u1',
    period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' },
    goals: [{ topicId, targetLevel, targetDepth: 3, sessions: 3 }],
    strategy: '测试种子计划',
    anchors: {
      initialMastery: { [topicId]: 0.1 },
      targetDepth: 3,
      targetDifficulty: 0.5,
      learningSpeedBaseline: 0.6,
      repetitionBias: 1,
    },
    status: 'confirmed',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  store.saveStudyPlan(id, plan);
  return plan;
}

test('run 生成 draft 复盘：加权评分 + md 落盘', async () => {
  const s = setup();
  try {
    seedProfile(s.store, '微积分', 0.8); // 已达标
    seedPlan(s.store, 'plan-1', '微积分', 0.5);
    const engine = new ReviewEngine(s.store, s.profileEngine);
    const { review, markdownPath } = await engine.run('u1', 'plan-1', { outputDir: s.dir });
    assert.equal(review.status, 'draft');
    assert.equal(review.planId, 'plan-1');
    assert.ok(review.scores.weighted > 0.5); // 达标 + 频率满 → 高分
    assert.ok(review.findings.length > 0);
    assert.ok(fs.existsSync(markdownPath));
    assert.match(fs.readFileSync(markdownPath, 'utf-8'), /## 加权评分/);
  } finally {
    cleanup(s);
  }
});

test('confirm 触发交叉确认：达标主题掌握度抬升 + 兴趣加权', async () => {
  const s = setup();
  try {
    seedProfile(s.store, '微积分', 0.8);
    seedPlan(s.store, 'plan-1', '微积分', 0.5);
    const engine = new ReviewEngine(s.store, s.profileEngine);
    const { review } = await engine.run('u1', 'plan-1', { outputDir: s.dir });
    await engine.confirm(review.id, { outputDir: s.dir });
    const after = s.store.getProfile('u1')!;
    assert.ok(Math.abs(after.mastery['微积分'].level - 0.85) < 1e-9, `掌握度应抬升到 0.85: ${after.mastery['微积分'].level}`);
    assert.equal(after.interest.topics['微积分'], 1);
    assert.equal(s.store.getReview(review.id)!.status, 'confirmed');
  } finally {
    cleanup(s);
  }
});

test('confirm 连续 2 次低分触发锚定反思（启发式）', async () => {
  const s = setup();
  try {
    seedProfile(s.store, '物理', 0.1); // 远未达标
    seedPlan(s.store, 'plan-a', '物理', 0.9);
    seedPlan(s.store, 'plan-b', '物理', 0.9);
    const engine = new ReviewEngine(s.store, s.profileEngine);
    // 先确认 r1（此时仅 1 条低分，不触发），再生成并确认 r2（连续 2 条低分触发）
    const r1 = await engine.run('u1', 'plan-a', { outputDir: s.dir });
    assert.ok(r1.review.scores.weighted < 0.5, `加权分应偏低: ${r1.review.scores.weighted}`);
    const c1 = await engine.confirm(r1.review.id, { outputDir: s.dir });
    assert.equal(c1.anchorAdjustment, null); // 仅 1 条低分不触发

    const r2 = await engine.run('u1', 'plan-b', { outputDir: s.dir });
    const c2 = await engine.confirm(r2.review.id, { outputDir: s.dir });
    assert.ok(c2.anchorAdjustment, '连续 2 次低分应触发锚定修正');
    assert.ok(['llm', 'heuristic'].includes(c2.anchorAdjustment!.method));
    // 审计落库 + md
    assert.equal(s.store.listAnchorAdjustments().length, 1);
    const md = path.join(s.dir, 'anchors', `${r2.review.id}.md`);
    assert.ok(fs.existsSync(md));
  } finally {
    cleanup(s);
  }
});

test('computeReviewScore 纯函数：权重归一化 + clamp', () => {
  const s = setup();
  try {
    const profile = seedProfile(s.store, '物理', 0.1);
    const plan = seedPlan(s.store, 'plan-c', '物理', 0.9);
    // 全部信号错误 + 无学习事件 → 低频低正确率
    const score = computeReviewScore(profile, plan, [], { goalCompletion: 100, signalAccuracy: 0, frequencyRate: 0, masteryChange: 0 });
    assert.ok(score.weighted >= 0 && score.weighted <= 1);
    assert.ok(score.goalCompletion === 0);
    assert.ok(score.frequencyRate === 0);
  } finally {
    cleanup(s);
  }
});

test('复盘幂等：同计划同批次不重复生成', async () => {
  const s = setup();
  try {
    seedProfile(s.store, '化学', 0.5);
    seedPlan(s.store, 'plan-1', '化学', 0.6);
    const engine = new ReviewEngine(s.store, s.profileEngine);
    const first = await engine.run('u1', 'plan-1', { outputDir: s.dir });
    const second = await engine.run('u1', 'plan-1', { outputDir: s.dir });
    assert.equal(second.review.id, first.review.id);
    assert.equal(s.store.listReviews().length, 1);
  } finally {
    cleanup(s);
  }
});

test('review latest 返回最新复盘', async () => {
  const s = setup();
  try {
    seedProfile(s.store, '生物', 0.5);
    seedPlan(s.store, 'plan-1', '生物', 0.6);
    const engine = new ReviewEngine(s.store, s.profileEngine);
    const { review } = await engine.run('u1', 'plan-1', { outputDir: s.dir });
    assert.equal(engine.latest()?.id, review.id);
  } finally {
    cleanup(s);
  }
});

test('StudyPlanEngine + ReviewEngine 端到端（无 LLM，启发式）', async () => {
  const s = setup();
  try {
    const planEngine = new StudyPlanEngine(s.store, s.profileEngine);
    const reviewEngine = new ReviewEngine(s.store, s.profileEngine);
    const { plan } = await planEngine.run('u1', '微积分', { outputDir: s.dir });
    planEngine.confirm(plan.id);
    const { review } = await reviewEngine.run('u1', plan.id, { outputDir: s.dir });
    assert.ok(review.scores);
    const c = await reviewEngine.confirm(review.id, { outputDir: s.dir });
    assert.equal(c.review.status, 'confirmed');
    // review 属于有效 StudyReview 类型
    const check: StudyReview = c.review;
    assert.ok(check.findings.length >= 0);
  } finally {
    cleanup(s);
  }
});
