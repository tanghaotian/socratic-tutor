import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayRecorder, buildThreadId } from '../src/tracing/replay.js';
import type { FrozenThread } from '../src/engines/eval/index.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-replay-'));
}

test('AC1 录制层：录制一轮对话生成合法 FrozenThread 落盘 data/threads', () => {
  const dir = tmpDir();
  try {
    const rec = new ReplayRecorder(dir);
    const ok = rec.record({
      threadId: 't-left-1',
      topic: 'math',
      userText: '勾股定理证明我不太懂',
      agentText: '我们来拆解一下',
      signal: 'confused',
    });
    assert.equal(ok, true);
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.endsWith('.json')), '应有线程文件落盘');
    const thread = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8')) as FrozenThread;
    assert.equal(thread.id, 't-left-1');
    assert.equal(thread.topic, 'math');
    assert.equal(thread.turns.length, 2);
    assert.equal(thread.turns[0].role, 'user');
    assert.equal(thread.turns[0].signal, 'confused');
    assert.equal(thread.turns[1].role, 'agent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1 幂等：同 threadId 不重复落盘', () => {
  const dir = tmpDir();
  try {
    const rec = new ReplayRecorder(dir);
    assert.equal(rec.record({ threadId: 't-x-1', userText: 'a', agentText: 'b' }), true);
    assert.equal(rec.record({ threadId: 't-x-1', userText: 'a2', agentText: 'b2' }), false, '重复应返回 false');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, '只保留一条线程');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildThreadId：同一 learner+topic+当日 收敛一致（幂等），且安全字符', () => {
  const a = buildThreadId('u1', '微积分', new Date('2026-09-10T00:00:00Z'));
  const b = buildThreadId('u1', '微积分', new Date('2026-09-10T23:00:00Z'));
  assert.equal(a, b);
  assert.ok(!a.includes(':'));
  assert.ok(/^t-u1-/.test(a));
  const c = buildThreadId('u1', undefined);
  assert.match(c, /-general-/);
});