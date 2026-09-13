import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  checkAnchorTrigger,
  adjustAnchors,
  latestAnchor,
} from '../src/engines/plans/anchor.js';
import { defaultAnchor } from '../src/engines/plans/util.js';
import type { StudyReview, AnchorSnapshot } from '../src/engines/plans/types.js';
import type { LearnerProfile } from '../src/engines/profile.js';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';

/** 桩 LLM：structuredCall 返回修正后锚点 */
class StubLLM implements LLMProvider {
  readonly id = 'stub';
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    return 'ok';
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    yield 'ok';
  }
  async structuredCall<T>(_s: string, _u: string, _schema: object): Promise<StructuredResult<T>> {
    return {
      ok: true,
      data: {
        initial_mastery: { 微积分: 0.2 },
        target_depth: 2,
        target_difficulty: 0.3,
        learning_speed_baseline: 0.4,
        repetition_bias: 2,
        reasons: ['锚点偏高，学员实际正确率偏低', '下调难度以适应当前水平'],
      } as T,
    };
  }
}

/** 失败桩 LLM：触发启发式降级 */
class FailLLM implements LLMProvider {
  readonly id = 'fail';
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    throw new Error('llm down');
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    throw new Error('llm down');
  }
  async structuredCall<T>(_s: string, _u: string, _schema: object): Promise<StructuredResult<T>> {
    return { ok: false, data: null as T };
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-anchor-'));
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  return { dir, store };
}

function cleanup(s: { dir: string; store: SqliteStorage }) {
  s.store.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
}

function seedProfile(store: SqliteStorage): LearnerProfile {
  const profile: LearnerProfile = {
    learnerId: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    mastery: { 微积分: { level: 0.15, mistakes: ['求导'], strengths: [] } },
    frequency: { totalSessions: 2, lastStudyDates: ['2026-09-08'], weeklyAvg: 2 },
    interest: { topics: {}, preferences: [] },
    learningSpeed: 0.5,
  };
  store.saveProfile('u1', profile);
  return profile;
}

function seedLowReview(store: SqliteStorage, id: string, weighted: number, seq = 1): StudyReview {
  const review: StudyReview = {
    id,
    learnerId: 'u1',
    planId: `plan-${id}`,
    period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' },
    scores: {
      goalCompletion: 0,
      signalAccuracy: 0.5,
      frequencyRate: 0.2,
      masteryChange: 0.1,
      weighted,
    },
    findings: ['目标未达成'],
    improvementNotes: ['降低难度'],
    anchors: defaultAnchor(seedProfileIfMissing(store)),
    status: 'confirmed',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: new Date(2026, 8, 8, 0, 0, seq).toISOString(),
  };
  store.saveReview(id, review);
  return review;
}

function seedProfileIfMissing(store: SqliteStorage): LearnerProfile {
  return store.getProfile('u1') ?? seedProfile(store);
}

test('checkAnchorTrigger：连续 streak 条加权分低于阈值才触发', () => {
  const s = setup();
  try {
    seedProfile(s.store);
    assert.equal(checkAnchorTrigger(s.store, 'u1', 2, 0.5), false); // 无复盘
    seedLowReview(s.store, 'r1', 0.3, 1);
    assert.equal(checkAnchorTrigger(s.store, 'u1', 2, 0.5), false); // 仅 1 条
    seedLowReview(s.store, 'r2', 0.4, 2);
    assert.equal(checkAnchorTrigger(s.store, 'u1', 2, 0.5), true); // 连续 2 条低分
    // 中间插一条高分 → 不触发
    seedLowReview(s.store, 'r3', 0.8, 3);
    assert.equal(checkAnchorTrigger(s.store, 'u1', 2, 0.5), false);
  } finally {
    cleanup(s);
  }
});

test('adjustAnchors：LLM 修正（method=llm）并审计落盘', async () => {
  const s = setup();
  try {
    const profile = seedProfile(s.store);
    seedLowReview(s.store, 'r1', 0.3);
    seedLowReview(s.store, 'r2', 0.4);
    const adj = await adjustAnchors(s.store, 'u1', 'r2', {
      streak: 2,
      threshold: 0.5,
      llm: new StubLLM(),
      outputDir: s.dir,
    });
    assert.ok(adj);
    assert.equal(adj.method, 'llm');
    assert.equal(adj.after.targetDepth, 2);
    assert.equal(adj.after.learningSpeedBaseline, 0.4);
    assert.ok(adj.reasons.length >= 2);
    // 审计：SQLite + md
    assert.equal(s.store.listAnchorAdjustments().length, 1);
    const md = path.join(s.dir, 'anchors', 'r2.md');
    assert.ok(fs.existsSync(md));
    assert.match(fs.readFileSync(md, 'utf-8'), /## 修正前锚点/);
    // latestAnchor = 修正后的 after
    const latest: AnchorSnapshot = latestAnchor(s.store, 'u1')!;
    assert.equal(latest.targetDepth, 2);
    void profile;
  } finally {
    cleanup(s);
  }
});

test('adjustAnchors：LLM 失败降级启发式（method=heuristic）', async () => {
  const s = setup();
  try {
    seedProfile(s.store);
    seedLowReview(s.store, 'r1', 0.3);
    seedLowReview(s.store, 'r2', 0.4);
    const adj = await adjustAnchors(s.store, 'u1', 'r2', {
      streak: 2,
      threshold: 0.5,
      llm: new FailLLM(),
      outputDir: s.dir,
    });
    assert.ok(adj);
    assert.equal(adj.method, 'heuristic');
    // 启发式：目标难度下调、速度基线回落
    assert.ok(adj.after.targetDifficulty < 0.6);
    assert.ok(adj.after.learningSpeedBaseline > 0);
    assert.ok(adj.reasons.length >= 1);
  } finally {
    cleanup(s);
  }
});

test('adjustAnchors：不满足触发条件返回 null', async () => {
  const s = setup();
  try {
    seedProfile(s.store);
    seedLowReview(s.store, 'r1', 0.3); // 仅 1 条
    const adj = await adjustAnchors(s.store, 'u1', 'r1', {
      streak: 2,
      threshold: 0.5,
      llm: new StubLLM(),
      outputDir: s.dir,
    });
    assert.equal(adj, null);
    assert.equal(s.store.listAnchorAdjustments().length, 0);
  } finally {
    cleanup(s);
  }
});

test('latestAnchor：无调整记录时返回 null，有则返回最近 after', async () => {
  const s = setup();
  try {
    seedProfile(s.store);
    assert.equal(latestAnchor(s.store, 'u1'), null);
    seedLowReview(s.store, 'r1', 0.3, 1);
    seedLowReview(s.store, 'r2', 0.4, 2);
    await adjustAnchors(s.store, 'u1', 'r2', {
      streak: 2,
      threshold: 0.5,
      llm: new StubLLM(),
      outputDir: s.dir,
    });
    assert.ok(latestAnchor(s.store, 'u1'));
  } finally {
    cleanup(s);
  }
});
