import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';
import { SocraticEngine, type AdaptiveProfile } from '../src/engines/socratic.js';
import { ProfileEngine } from '../src/engines/profile.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  StrategyManager,
  createSocraticCoreSkill,
  createInterestSkill,
  createProfileCoreSkill,
  type CapabilitySkill,
} from '../src/engines/skills/index.js';

/** 桩 LLM：chat 返回占位文案，structuredCall 返回默认 correct */
class StubLLM implements LLMProvider {
  readonly id = 'stub';
  async chat(_msgs: ChatMessage[], _opts?: LLMOptions): Promise<string> {
    return '（测试生成的引导语）';
  }
  async *streamChat(_msgs: ChatMessage[], _opts?: LLMOptions): AsyncIterable<string> {
    yield '引导';
  }
  async structuredCall<T>(_system: string, _user: string, _schema: object): Promise<StructuredResult<T>> {
    return { ok: true, data: { signal: 'correct', confidence: 0.9 } as T };
  }
}

function profile(): AdaptiveProfile {
  return { adjustDepth: () => 1, mastery: () => 0.5 };
}

function tmpDb(): { dir: string; store: SqliteStorage } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-skills-'));
  return { dir, store: new SqliteStorage(path.join(dir, 'learner.db')) };
}

test('register 新增与替换（同 id 替换版本）', () => {
  const m = new StrategyManager();
  m.register(createProfileCoreSkill());
  assert.equal(m.listAll().length, 1);

  const replaced: CapabilitySkill = {
    id: 'profile.core',
    engine: 'profile',
    version: '9.9.9',
    describe: () => ({ id: 'profile.core', engine: 'profile', version: '9.9.9', purpose: 'x' }),
    apply: () => ({
      engine: 'profile',
      meta: { id: 'profile.core', engine: 'profile', version: '9.9.9', purpose: 'x' },
    }),
  };
  m.register(replaced);
  assert.equal(m.listAll().length, 1, '同 id 替换不新增');
  assert.equal(m.listAll()[0].version, '9.9.9');
});

test('enable/disable 生效，list 只返回激活', () => {
  const m = new StrategyManager();
  m.register(createInterestSkill());
  m.register(createProfileCoreSkill());
  assert.equal(m.list('socratic').length, 1);
  m.disable('socratic', 'socratic.interest');
  assert.equal(m.list('socratic').length, 0);
  assert.equal(m.listAll().length, 2, 'listAll 含禁用');
  m.enable('socratic', 'socratic.interest');
  assert.equal(m.list('socratic').length, 1);
});

test('snapshot 导出某引擎激活配置', () => {
  const m = new StrategyManager();
  m.register(createInterestSkill());
  m.register(createProfileCoreSkill());
  m.disable('socratic', 'socratic.interest');
  assert.deepEqual(m.snapshot('socratic'), []);
  m.enable('socratic', 'socratic.interest');
  const snap = m.snapshot('socratic');
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'socratic.interest');
  assert.equal(snap[0].enabled, true);
});

test('socratic core 单独 run 产出动作（旧行为回归）', async () => {
  const llm = new StubLLM();
  const m = new StrategyManager();
  m.register(createSocraticCoreSkill(llm));
  const results = await m.run('socratic', {
    input: '因为导数是变化率',
    signal: { signal: 'correct', confidence: 1, conceptIds: [], errorCategories: [] },
    profile: profile(),
    history: [],
    llm,
  });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.ok(r.engine === 'socratic' && r.action);
  assert.equal(r.action.type, 'ask');
});

test('叠加：core + interest 改写最终动作文案', async () => {
  const llm = new StubLLM();
  const m = new StrategyManager();
  m.register(createSocraticCoreSkill(llm));
  m.register(createInterestSkill());
  const results = await m.run('socratic', {
    input: '极限',
    profile: profile(),
    history: [],
    llm,
  });
  const finalAction = [...results]
    .reverse()
    .map((r) => (r.engine === 'socratic' ? r.action : undefined))
    .find((a) => a !== undefined);
  assert.ok(finalAction && 'content' in finalAction);
  assert.ok(finalAction.content.includes('离答案已经很近了'), 'interest 叠加应改写文案');
});

test('禁用 core 后仅 interest 无动作可叠加 → 无产出', async () => {
  const llm = new StubLLM();
  const m = new StrategyManager();
  m.register(createSocraticCoreSkill(llm));
  m.register(createInterestSkill());
  m.disable('socratic', 'socratic.core');
  const results = await m.run('socratic', {
    input: 'x',
    profile: profile(),
    history: [],
    llm,
  });
  const action = results
    .map((r) => (r.engine === 'socratic' ? r.action : undefined))
    .find((a) => a !== undefined);
  assert.equal(action, undefined);
});

test('ProfileEngine 经 manager 合并 delta 落库（profile core 回归）', async () => {
  const { dir, store } = tmpDb();
  try {
    const engine = new ProfileEngine(store);
    const p0 = engine.getOrCreate('u1');
    const l0 = p0.mastery['math']?.level ?? 0.5;
    await engine.updateFromSignal('u1', 'correct', 'math');
    const p1 = engine.getOrCreate('u1');
    assert.ok(p1.mastery['math'].level > l0);
    assert.equal(p1.mastery['math'].strengths.length, 1);
    assert.equal(p1.frequency.totalSessions, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('profile 侧叠加：多 skill 的 delta 合并', async () => {
  const { dir, store } = tmpDb();
  try {
    const m = new StrategyManager();
    m.register(createProfileCoreSkill());
    m.register({
      id: 'profile.bonus',
      engine: 'profile',
      version: '0.1.0',
      describe: () => ({ id: 'profile.bonus', engine: 'profile', version: '0.1.0', purpose: 'bonus' }),
      apply: () => ({
        engine: 'profile',
        delta: { interestDelta: { bonus: 5 } },
        meta: { id: 'profile.bonus', engine: 'profile', version: '0.1.0', purpose: 'bonus' },
      }),
    });
    const engine = new ProfileEngine(store, m);
    await engine.updateFromSignal('u1', 'correct', 'math');
    const p = engine.getOrCreate('u1');
    assert.equal(p.interest.topics['bonus'], 5, '叠加 skill 的兴趣增量应生效');
    assert.ok((p.mastery['math']?.level ?? 0.5) > 0.5, 'core 的掌握度增量应生效');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎注入自定义 manager：disable core 后 generateAction 抛错', async () => {
  const llm = new StubLLM();
  const m = new StrategyManager();
  m.register(createSocraticCoreSkill(llm));
  const engine = new SocraticEngine(llm, m);
  const a = await engine.generateAction({ answer: 'x', profile: profile() });
  assert.equal(a.type, 'ask');

  m.disable('socratic', 'socratic.core');
  await assert.rejects(() => engine.generateAction({ answer: 'x', profile: profile() }));
});
