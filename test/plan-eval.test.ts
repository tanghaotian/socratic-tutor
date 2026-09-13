import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runStrategyEval,
  applyStrategy,
  readActiveStrategies,
  createStrategyManagerFromRegistry,
  type StrategyEvalThread,
} from '../src/engines/plans/eval.js';
import type { PlanReviewStrategyConfig } from '../src/engines/plans/types.js';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';

/** 桩 judge：从用户提示中识别策略 id，candidate 版本给更高分 */
class StubJudge implements LLMProvider {
  readonly id = 'judge';
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    return 'ok';
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    yield 'ok';
  }
  async structuredCall<T>(_s: string, user: string, _schema: object): Promise<StructuredResult<T>> {
    const adaptive = user.includes('adaptive');
    const score = adaptive ? 8 : 5;
    return {
      ok: true,
      data: { plan_quality: score, review_quality: score } as T,
    };
  }
}

const THREADS: StrategyEvalThread[] = [
  { id: 't1', topic: '微积分', turns: [{ role: 'user', content: '讲解极限', signal: 'correct' }] },
  { id: 't2', topic: '线性代数', turns: [{ role: 'user', content: '矩阵运算', signal: 'mistake' }] },
];

const BASELINE: PlanReviewStrategyConfig[] = [
  { id: 'plans.default', kind: 'plan', version: '1.0.0' },
  { id: 'reviews.default', kind: 'review', version: '1.0.0' },
];

const CANDIDATE: PlanReviewStrategyConfig[] = [
  { id: 'plans.adaptive', kind: 'plan', version: '1.1.0', planPrompt: '优先薄弱主题' },
  { id: 'reviews.adaptive', kind: 'review', version: '1.1.0', reviewPrompt: '细粒度归因' },
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-eval-'));
  return dir;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('组合加权合成 + candidate 更高 → accepted', async () => {
  const dir = setup();
  try {
    const report = await runStrategyEval({
      baseline: BASELINE,
      candidate: CANDIDATE,
      threads: THREADS,
      judgeProvider: new StubJudge(),
      outputDir: dir,
    });
    assert.equal(report.verdict, 'accepted');
    assert.equal(report.judgeDegraded, false);
    // 加权合成 = 0.5*plan + 0.5*review
    assert.equal(report.combined.candidate, 8);
    assert.equal(report.combined.baseline, 5);
    // 报告落盘
    const files = fs.readdirSync(path.join(dir, 'evals')).filter((f) => f.endsWith('_strategy.json'));
    assert.equal(files.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('candidate 低于达标线 → rejected（不应用）', async () => {
  const dir = setup();
  try {
    const report = await runStrategyEval({
      baseline: BASELINE,
      candidate: CANDIDATE,
      threads: THREADS,
      judgeProvider: new StubJudge(),
      outputDir: dir,
      minScore: 9, // 达标线高于 8
    });
    assert.equal(report.verdict, 'rejected');
  } finally {
    cleanup(dir);
  }
});

test('judge 缺失 → 降级启发式同分 → needs_review（不自动应用）', async () => {
  const dir = setup();
  try {
    const report = await runStrategyEval({
      baseline: BASELINE,
      candidate: CANDIDATE,
      threads: THREADS,
      judgeProvider: undefined,
      outputDir: dir,
    });
    assert.equal(report.judgeDegraded, true);
    assert.equal(report.verdict, 'needs_review');
  } finally {
    cleanup(dir);
  }
});

test('candidate 达标但无提升 → needs_review', async () => {
  const dir = setup();
  try {
    // 桩 judge 对 baseline/candidate 同分（无 adaptive 字样 → 都是 5？）
    // 这里构造：candidate 名称不带 adaptive → 与 baseline 同分
    const report = await runStrategyEval({
      baseline: BASELINE,
      candidate: [
        { id: 'plans.same', kind: 'plan', version: '1.0.1' },
        { id: 'reviews.same', kind: 'review', version: '1.0.1' },
      ],
      threads: THREADS,
      judgeProvider: new StubJudge(),
      outputDir: dir,
      minScore: 5, // 达标线=5，candidate=5 达标但 = baseline
    });
    assert.equal(report.combined.candidate, 5);
    assert.equal(report.verdict, 'needs_review');
  } finally {
    cleanup(dir);
  }
});

test('applyStrategy 幂等写入 active.json 并可重读', () => {
  const dir = setup();
  try {
    assert.deepEqual(readActiveStrategies(dir), []);
    applyStrategy(CANDIDATE[0], dir);
    applyStrategy(CANDIDATE[1], dir);
    let active = readActiveStrategies(dir);
    assert.equal(active.length, 2);
    // 同 kind+id 覆盖（版本升级）
    applyStrategy({ id: 'plans.adaptive', kind: 'plan', version: '1.2.0' }, dir);
    active = readActiveStrategies(dir);
    assert.equal(active.length, 2);
    assert.equal(active.find((c) => c.kind === 'plan')!.version, '1.2.0');
  } finally {
    cleanup(dir);
  }
});

test('createStrategyManagerFromRegistry：已应用策略装配 + 缺省回退默认', () => {
  const dir = setup();
  try {
    // 空注册表 → 默认策略
    let m = createStrategyManagerFromRegistry(dir);
    assert.equal(m.plan.describe().id, 'plans.default');
    assert.equal(m.review.describe().id, 'reviews.default');
    // 写入候选后 → 装配候选
    applyStrategy(CANDIDATE[0], dir);
    applyStrategy(CANDIDATE[1], dir);
    m = createStrategyManagerFromRegistry(dir);
    assert.equal(m.plan.describe().id, 'plans.adaptive');
    assert.equal(m.review.describe().id, 'reviews.adaptive');
  } finally {
    cleanup(dir);
  }
});
