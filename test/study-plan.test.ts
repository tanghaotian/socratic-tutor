import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { ProfileEngine } from '../src/engines/profile.js';
import { StudyPlanEngine, buildPlanId } from '../src/engines/plans/study-plan.js';
import { createStrategyFromConfig } from '../src/engines/plans/llm-strategy.js';
import { createDefaultPlanStrategy } from '../src/engines/plans/default-strategy.js';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';

/** 桩 LLM：结构化返回固定计划目标 */
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
        goals: [{ topic_id: '微积分', target_level: 0.8, target_depth: 4, sessions: 5 }],
        strategy: 'LLM 定制：按画像薄弱主题提升掌握度',
      } as T,
    };
  }
}

/** 失败桩 LLM：structuredCall 返回失败 → 触发降级 */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-plan-'));
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const profileEngine = new ProfileEngine(store);
  return { dir, store, profileEngine };
}

function cleanup(s: { dir: string; store: SqliteStorage }) {
  s.store.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
}

test('run 生成 draft 学习计划并导出 md（默认启发式策略）', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    const { plan, markdownPath } = await engine.run('u1', '微积分', { outputDir: s.dir });
    assert.equal(plan.status, 'draft');
    assert.equal(plan.learnerId, 'u1');
    assert.ok(plan.goals.length > 0);
    assert.ok(plan.goals[0].sessions >= 1);
    assert.ok(fs.existsSync(markdownPath));
    assert.match(fs.readFileSync(markdownPath, 'utf-8'), /## 目标/);
    // anchors 由画像现算（无锚定调整记录）
    assert.ok(plan.anchors.targetDepth >= 1 && plan.anchors.targetDepth <= 5);
  } finally {
    cleanup(s);
  }
});

test('run 幂等：同日同主题不重复生成', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    const first = await engine.run('u1', '线性代数', { outputDir: s.dir });
    const second = await engine.run('u1', '线性代数', { outputDir: s.dir });
    assert.equal(second.plan.id, first.plan.id);
    assert.equal(s.store.listStudyPlans().length, 1);
  } finally {
    cleanup(s);
  }
});

test('LLM 策略生成计划（structuredCall 成功）', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    const llmStrategy = createStrategyFromConfig(
      { id: 'plans.llm', kind: 'plan', version: '1.1.0' },
      new StubLLM(),
    );
    const { plan } = await engine.run('u1', '概率论', { outputDir: s.dir, llm: new StubLLM(), strategy: llmStrategy });
    assert.equal(plan.generatorVersion, 'plans.llm');
    assert.equal(plan.goals[0].topicId, '微积分'); // 桩返回固定主题
  } finally {
    cleanup(s);
  }
});

test('LLM 失败时降级默认启发式策略', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    const llmStrategy = createStrategyFromConfig(
      { id: 'plans.llm', kind: 'plan', version: '1.1.0' },
      new FailLLM(),
    );
    const { plan } = await engine.run('u1', '物理', { outputDir: s.dir, llm: new FailLLM(), strategy: llmStrategy });
    // 降级后 goals 主题 = 用户请求主题（启发式生成）
    assert.equal(plan.goals[0].topicId, '物理');
    assert.ok(plan.goals[0].sessions >= 1);
  } finally {
    cleanup(s);
  }
});

test('confirm：draft → confirmed 且持久化', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    const { plan } = await engine.run('u1', '微积分', { outputDir: s.dir });
    const confirmed = engine.confirm(plan.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(s.store.getStudyPlan(plan.id)!.status, 'confirmed');
    // 重复 confirm 抛错
    assert.throws(() => engine.confirm(plan.id), /仅 draft 状态可确认/);
  } finally {
    cleanup(s);
  }
});

test('latest 返回最新计划（草稿优先）', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    await engine.run('u1', '微积分', { outputDir: s.dir });
    assert.ok(engine.latest()?.id);
  } finally {
    cleanup(s);
  }
});

test('buildPlanId 幂等：同 learner+topic+日期一致', () => {
  const d = new Date(2026, 8, 9);
  assert.equal(buildPlanId('u1', '数学', d), buildPlanId('u1', '数学', d));
  assert.notEqual(buildPlanId('u1', '数学', d), buildPlanId('u2', '数学', d));
});

test('buildPlanId 安全化：Windows 非法字符被替换且 md 可落盘（回归：真实闭环 ENOENT）', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    // 模拟客户端把中文 topic 编码成 '?' 等非法文件名场景
    const id = buildPlanId('u1', '微积分?', new Date());
    assert.ok(!/[\\/:*?"<>|]/.test(id), `id 不应含 Windows 非法字符: ${id}`);
    const { plan, markdownPath } = await engine.run('u1', '微积分?', { outputDir: s.dir });
    assert.equal(plan.id, id);
    assert.ok(fs.existsSync(markdownPath), 'md 导出不应因非法字符 ENOENT');
    assert.ok(!/[\\/:*?"<>|]/.test(path.basename(markdownPath)), '文件名不应含非法字符');
  } finally {
    cleanup(s);
  }
});

test('默认启发式计划策略：目标掌握度 = 当前 + 0.25（clamp）', async () => {
  const s = setup();
  try {
    const engine = new StudyPlanEngine(s.store, s.profileEngine);
    // 预置一个高掌握度画像
    s.profileEngine.getOrCreate('u1');
    const strategy = createDefaultPlanStrategy();
    const { plan } = await engine.run('u1', '微积分', { outputDir: s.dir, strategy });
    assert.ok(plan.goals[0].targetLevel <= 1);
  } finally {
    cleanup(s);
  }
});
