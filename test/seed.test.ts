import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedThreads, toFrozenThread, SEED_THREADS } from '../src/tracing/seed.js';
import { GoldenDataset } from '../src/tracing/golden.js';
import { loadFrozenThreads } from '../src/scheduler/eval-cron.js';
import { sampleThreads } from '../src/tracing/sample.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-seed-'));
}

test('种子线程：落盘为 FrozenThread 标准格式，可被 loadFrozenThreads 直接读取', () => {
  const dir = tmpDir();
  try {
    const written = seedThreads(dir, SEED_THREADS, new Date('2026-09-13T00:00:00Z'));
    assert.equal(written, SEED_THREADS.length);

    // 关键：评测链路读得到的才是有效数据（此前 data/threads 只有非标准手工样例）
    const loaded = loadFrozenThreads(dir);
    assert.equal(loaded.length, SEED_THREADS.length);
    for (const t of loaded) {
      assert.equal(typeof t.id, 'string');
      assert.ok(t.id.length > 0);
      assert.equal(typeof t.topic, 'string');
      assert.ok(t.turns.length >= 2, '每条种子线程应为多轮');
      for (const turn of t.turns) {
        assert.ok(turn.role === 'user' || turn.role === 'agent');
        assert.equal(typeof turn.content, 'string');
      }
    }
    // 覆盖多主题，满足评测按 topic 分层抽样
    const topics = new Set(loaded.map((t) => t.topic));
    assert.ok(topics.size >= 3, `应覆盖多个主题，实际 ${topics.size}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('种子线程：幂等，重复执行不产生重复样本', () => {
  const dir = tmpDir();
  try {
    const when = new Date('2026-09-13T00:00:00Z');
    assert.equal(seedThreads(dir, SEED_THREADS, when), SEED_THREADS.length);
    assert.equal(seedThreads(dir, SEED_THREADS, when), 0, '第二次应为 0（已存在跳过）');
    assert.equal(loadFrozenThreads(dir).length, SEED_THREADS.length, '不得重复累积');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('种子线程：含失败信号，能被失败优先抽样识别（评测有区分度）', async () => {
  const dir = tmpDir();
  try {
    seedThreads(dir, SEED_THREADS, new Date('2026-09-13T00:00:00Z'));
    const all = loadFrozenThreads(dir);
    const sampled = await sampleThreads(all, { size: 2, failureWeight: 3 });
    assert.ok(sampled.length > 0, '应能抽到样本');
    // 种子数据必须包含失败信号，否则「失败优先」抽样无意义
    const failureSampled = sampled.filter((t) =>
      t.turns.some((turn) => turn.signal === 'mistake' || turn.signal === 'confused'),
    );
    assert.ok(failureSampled.length > 0, '抽样结果中应含失败信号线程');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toFrozenThread：保留主题与多轮信号', () => {
  const seed = SEED_THREADS[0];
  const frozen = toFrozenThread('t-test-1', seed);
  assert.equal(frozen.id, 't-test-1');
  assert.equal(frozen.topic, seed.topic);
  assert.deepEqual(frozen.turns, seed.turns);
});

// 回归 BUG-003：黄金数据集默认落在 data/threads/golden.json，
// 而 loadFrozenThreads 扫描该目录全部 *.json → 同一条线程被计入两次（实测 4 → 8）。
test('回归 BUG-003：golden.json 不被当作线程重复加载', async () => {
  const dir = tmpDir();
  try {
    seedThreads(dir, SEED_THREADS, new Date('2026-09-13T00:00:00Z'));
    const before = loadFrozenThreads(dir).length;
    assert.equal(before, SEED_THREADS.length);

    // 刷新黄金数据集（默认写入同目录 golden.json）
    const goldenFile = path.join(dir, 'golden.json');
    const golden = new GoldenDataset(goldenFile);
    await golden.refresh(loadFrozenThreads(dir), { size: 2, failureWeight: 3 });
    assert.ok(fs.existsSync(goldenFile), '黄金集应已落盘');

    const after = loadFrozenThreads(dir);
    assert.equal(after.length, before, 'golden.json 不得使线程数翻倍');
    const ids = after.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, '不得出现重复 id');

    // 目录内确实存在 golden.json，证明跳过逻辑生效而非文件未生成
    assert.ok(fs.readdirSync(dir).includes('golden.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
