import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { ProfileEngine } from '../src/engines/profile.js';

function tmpDb(): { dir: string; store: SqliteStorage } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-profile-'));
  return { dir, store: new SqliteStorage(path.join(dir, 'learner.db')) };
}

test('画像可持久化并可读回', async () => {
  const { dir, store } = tmpDb();
  try {
    const engine = new ProfileEngine(store);
    const a = engine.getOrCreate('u1');
    assert.equal(a.learnerId, 'u1');
    assert.equal(a.frequency.totalSessions, 0);

    await engine.updateFromSignal('u1', 'correct', 'calculus');
    await engine.updateFromSignal('u1', 'mistake', 'calculus');

    // 重新打开连接（模拟重启后持久化）
    store.close();
    const store2 = new SqliteStorage(path.join(dir, 'learner.db'));
    const engine2 = new ProfileEngine(store2);
    const p = engine2.getOrCreate('u1');
    assert.equal(p.frequency.totalSessions, 2);
    assert.equal(p.mastery['calculus'].mistakes.length, 1);
    assert.equal(p.mastery['calculus'].strengths.length, 1);
    store2.close();
    return;
  } finally {
    if (!store.isClosed()) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('正确→掌握度上升，错误→掌握度下降', async () => {
  const { store } = tmpDb();
  const engine = new ProfileEngine(store);
  const p0 = engine.getOrCreate('u2');
  const l0 = p0.mastery['physics']?.level ?? 0.5;

  const p1 = await engine.updateFromSignal('u2', 'correct', 'physics');
  assert.ok(p1.mastery['physics'].level > l0);

  const p2 = await engine.updateFromSignal('u2', 'mistake', 'physics');
  assert.ok(p2.mastery['physics'].level < p1.mastery['physics'].level);
});

test('累计错误次数与自适应重复度正相关', async () => {
  const { store } = tmpDb();
  const engine = new ProfileEngine(store);
  await engine.updateFromSignal('u3', 'mistake', 'os');
  await engine.updateFromSignal('u3', 'mistake', 'os');
  await engine.updateFromSignal('u3', 'mistake', 'os');
  const p = engine.getOrCreate('u3');
  assert.equal(p.mastery['os'].mistakes.length, 3);
  assert.equal(engine.adaptiveParams('u3', 'os').repetition, 3);
});

test('周均学习次数只统计近 7 天', async () => {
  const { store } = tmpDb();
  const engine = new ProfileEngine(store);
  // 多次学习同一天只计一次周均
  for (let i = 0; i < 5; i++) await engine.updateFromSignal('u4', 'correct', 'math');
  const p = engine.getOrCreate('u4');
  assert.equal(p.frequency.totalSessions, 5);
  assert.equal(p.frequency.weeklyAvg, 1);
});

test('toAdaptiveView 可注入 IT2 SocraticEngine', async () => {
  const { store } = tmpDb();
  const engine = new ProfileEngine(store);
  await engine.updateFromSignal('u5', 'correct', 'algo');
  const view = engine.toAdaptiveView('u5', 'algo');
  assert.equal(typeof view.mastery(), 'number');
  assert.ok(view.adjustDepth('correct') >= 0);
});