import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';
import {
  EvalManager,
  SelfBuiltBackend,
  externalBackends,
  runEvalGate,
  type FrozenThread,
  type SnapshotRunner,
  type EngineObservation,
  type ActiveSkill,
} from '../src/engines/eval/index.js';

/** 响应式桩 LLM：可控地返回 judge structuredCall 结果 或 抛错（触发降级） */
class JudgeLLM implements LLMProvider {
  readonly id = 'judge';
  private result: StructuredResult<any> | null;
  private fail: boolean;
  constructor(result: StructuredResult<any> | null, fail = false) {
    this.result = result;
    this.fail = fail;
  }
  async chat(_msgs: ChatMessage[], _opts?: LLMOptions): Promise<string> {
    return '（生成）';
  }
  async *streamChat(_msgs: ChatMessage[], _opts?: LLMOptions): AsyncIterable<string> {
    yield '生成';
  }
  async structuredCall<T>(_system: string, _user: string, _schema: object): Promise<StructuredResult<T>> {
    if (this.fail) return { ok: false, message: 'judge failed' };
    if (this.result) return this.result as StructuredResult<T>;
    return { ok: false, message: 'no response' };
  }
}

const baseline = { id: 'socratic.core', engine: 'socratic', version: '0.1.0', enabled: true } as ActiveSkill;
const candidate = { id: 'socratic.core', engine: 'socratic', version: '0.1.1', enabled: true } as ActiveSkill;

const thread: FrozenThread = {
  id: 't1',
  topic: '极限',
  turns: [
    { role: 'user', content: '什么是导数？' },
    { role: 'agent', content: '你认为导数想解决什么问题呢？' },
    { role: 'user', content: '变化率' },
  ],
};

const observer: SnapshotRunner = {
  async run(_skills: ActiveSkill[], _t: FrozenThread): Promise<EngineObservation> {
    return { texts: [''], summary: '回复内容' };
  },
};

test('EvalManager 注册/切换/list/run', async () => {
  const m = new EvalManager();
  m.register(new SelfBuiltBackend());
  assert.equal(m.activeId, 'self-built');
  assert.deepEqual(m.listBackends(), ['self-built']);

  // 未注册后端切换抛错
  assert.throws(() => m.setActive('promptfoo'), /未注册/);

  for (const b of externalBackends) m.register(b);
  assert.deepEqual(m.listBackends(), ['self-built', 'promptfoo', 'agentbench', 'deepeval']);
  m.setActive('promptfoo');
  assert.equal(m.activeId, 'promptfoo');
  const report = await m.run({
    engine: 'socratic',
    baselineSnapshot: { label: 'baseline', activeSkills: [baseline] },
    candidateSnapshot: { label: 'candidate', activeSkills: [candidate] },
    threads: [thread],
    judgeProvider: new JudgeLLM(null),
  });
  assert.equal(report.verdict, 'needs_review', '外部占位后端返回 needs_review');
  assert.ok(report.backendNote?.startsWith('promptfoo'));
});

test('EvalManager 未设置后端 run 抛错', async () => {
  const m = new EvalManager();
  await assert.rejects(
    () =>
      m.run({
        engine: 'socratic',
        baselineSnapshot: { label: 'baseline', activeSkills: [baseline] },
        candidateSnapshot: { label: 'candidate', activeSkills: [candidate] },
        threads: [thread],
        judgeProvider: new JudgeLLM(null),
        runner: observer,
      }),
    /后端未设置/,
  );
});

test('self-built：judge 判 candidate 且高分 → accepted', async () => {
  const m = new EvalManager();
  m.register(new SelfBuiltBackend());
  const judge = new JudgeLLM({
    ok: true,
    data: {
      dimension_scores: { engagement: 8, nondirect: 8, clarity: 8, adaptivity: 8 },
      ab: 'candidate',
    },
  });
  const report = await m.run({
    engine: 'socratic',
    baselineSnapshot: { label: 'baseline', activeSkills: [baseline] },
    candidateSnapshot: { label: 'candidate', activeSkills: [candidate] },
    threads: [thread],
    judgeProvider: judge,
    runner: observer,
  });
  assert.equal(report.verdict, 'accepted');
  assert.equal(report.judgeDegraded, false);
  assert.equal(report.metrics.abWinRate.candidateWins, 1);
  // candidate 各维 8+0.5
  assert.equal(report.metrics.rubric['engagement'].candidate, 8.5);
  assert.ok(report.metrics.rubric['engagement'].delta > 0);
  assert.ok(report.reasons.join(' ').includes('≥6'));
});

test('self-built：judge 判 baseline（核心维回退）→ rejected', async () => {
  const m = new EvalManager();
  m.register(new SelfBuiltBackend());
  const judge = new JudgeLLM({
    ok: true,
    data: { dimension_scores: {}, ab: 'baseline' },
  });
  const report = await m.run({
    engine: 'socratic',
    baselineSnapshot: { label: 'baseline', activeSkills: [baseline] },
    candidateSnapshot: { label: 'candidate', activeSkills: [candidate] },
    threads: [thread],
    judgeProvider: judge,
    runner: observer,
  });
  assert.equal(report.verdict, 'rejected');
  assert.ok(report.reasons.join(' ').includes('核心维回退'));
});

test('self-built：judge 失败降级为启发式（judgeDegraded 标记）', async () => {
  const m = new EvalManager();
  m.register(new SelfBuiltBackend());
  const judge = new JudgeLLM(null, true);
  const report = await m.run({
    engine: 'socratic',
    baselineSnapshot: { label: 'baseline', activeSkills: [baseline] },
    candidateSnapshot: { label: 'candidate', activeSkills: [candidate] },
    threads: [thread],
    judgeProvider: judge,
    runner: observer,
  });
  assert.equal(report.judgeDegraded, true);
  assert.match(report.verdict, /needs_review|rejected/);
});

test('self-built：无 runner 抛错', async () => {
  const m = new EvalManager();
  m.register(new SelfBuiltBackend());
  await assert.rejects(
    () =>
      m.run({
        engine: 'socratic',
        baselineSnapshot: { label: 'baseline', activeSkills: [baseline] },
        candidateSnapshot: { label: 'candidate', activeSkills: [candidate] },
        threads: [thread],
        judgeProvider: new JudgeLLM(null),
      }),
    /需要 req.runner/,
  );
});

test('EvalGate 端到端（socratic + 真实 skill 重放）落盘周报', async () => {
  const { dir, clean } = tmpDir();
  try {
    const judge = new JudgeLLM({
      ok: true,
      data: { dimension_scores: {}, ab: 'tie' },
    });
    const { report, file } = await runEvalGate({
      engine: 'socratic',
      baselineSkills: [baseline],
      candidateSkills: [candidate],
      threads: [thread, thread],
      kind: 'weekly',
      sampledFrom: 10,
      judgeProvider: judge,
      outputDir: dir,
    });
    assert.equal(report.threadsReplayed, 2);
    assert.equal(report.sampledFrom, 10);
    assert.equal(report.engine, 'socratic');
    assert.ok(fs.existsSync(file), '周报应落盘');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.verdict, report.verdict);
  } finally {
    clean();
  }
});

test('EvalGate 切换外部占位后端（profile 引擎）', async () => {
  const { dir, clean } = tmpDir();
  try {
    const { report, file } = await runEvalGate({
      engine: 'profile',
      baselineSkills: [baseline],
      candidateSkills: [candidate],
      threads: [thread],
      backendId: 'deepeval',
      judgeProvider: new JudgeLLM(null),
      outputDir: dir,
    });
    assert.equal(report.verdict, 'needs_review');
    assert.ok(report.backendNote?.startsWith('deepeval'));
    assert.ok(fs.existsSync(file));
  } finally {
    clean();
  }
});

function tmpDir(): { dir: string; clean: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-eval-'));
  return { dir, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}