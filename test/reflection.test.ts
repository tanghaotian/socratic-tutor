import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { ReflectionEngine } from '../src/engines/reflection.js';
import { Scheduler } from '../src/scheduler/index.js';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';

/** 桩 LLM：结构化返回固定反思字段 */
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
        observations: ['本周微积分练习频率下降'],
        improvements: ['面对连续困惑时增加提示阶梯'],
        new_feature_requests: ['增加每日学习打卡'],
        resource_additions: ['《苏格拉底对话教学法》'],
      } as T,
    };
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-refl-'));
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new StubLLM();
  const engine = new ReflectionEngine(llm, store);
  return { dir, store, engine };
}

function cleanup({ dir, store }: { dir: string; store: SqliteStorage }) {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('手动触发生成 draft 报告并导出 md', async () => {
  const s = setup();
  try {
    const { report, markdownPath } = await s.engine.run('manual', { outputDir: s.dir });
    assert.equal(report.status, 'draft');
    assert.equal(report.trigger, 'manual');
    assert.ok(report.observations.length > 0);
    assert.ok(fs.existsSync(markdownPath));
    assert.match(fs.readFileSync(markdownPath, 'utf-8'), /## 观察点/);
    // 未 confirm 前状态仍是 draft
    assert.equal(s.engine.latest()!.status, 'draft');
  } finally {
    cleanup(s);
  }
});

test('confirm 变更状态且最终持久化', async () => {
  const s = setup();
  try {
    const { report } = await s.engine.run('weekly', { outputDir: s.dir });
    const confirmed = s.engine.confirm(report.id);
    assert.equal(confirmed.status, 'confirmed');
    // 读回验证持久化
    assert.equal(s.store.getReflection(report.id)!.status, 'confirmed');
  } finally {
    cleanup(s);
  }
});

test('同一批手动反思幂等：不重复生成', async () => {
  const s = setup();
  try {
    await s.engine.run('manual', { outputDir: s.dir });
    const second = await s.engine.run('manual', { outputDir: s.dir });
    const all = s.store.listReflections().filter((r) => r.trigger === 'manual');
    assert.equal(all.length, 1);
    assert.equal(second.report.id, all[0].id);
  } finally {
    cleanup(s);
  }
});

test('Scheduler 手动 run 可用', async () => {
  const s = setup();
  try {
    const scheduler = new Scheduler(new StubLLM(), s.store);
    const { report } = await scheduler.run('manual', { outputDir: s.dir });
    assert.ok(report.id);
  } finally {
    cleanup(s);
  }
});