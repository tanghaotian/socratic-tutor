import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';
import type { ActiveSkill, FrozenThread } from '../src/engines/eval/index.js';
import {
  classifyMethodology,
  extractRules,
  buildSkillCode,
  createSkillFromRules,
  generateFromKnowledge,
  runSkillGenPipeline,
  scanKnowledgeDirForSkills,
  idFromFilename,
  applyGeneratedSkill,
  listAppliedSkills,
  createEngineManagerFromRegistry,
  removeAppliedSkill,
  type SkillRules,
} from '../src/engines/skillgen/index.js';
import { StrategyManager, createSocraticCoreSkill } from '../src/engines/skills/index.js';
import { ReflectionEngine } from '../src/engines/reflection.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const METHODOLOGY_MD = `# 苏格拉底提问技巧
本文介绍通过层层提问引导学习者自主思考的教学方法。
- 开放式提问激发兴趣。
- 认知冲突促进深度理解。
- 及时反馈与激励保持学习动力。`;

const NON_METHODOLOGY_MD = `# 微积分历史
牛顿与莱布尼茨在 17 世纪各自独立发展出微积分，后世围绕优先权产生争议。`;

/** 桩 LLM：默认判方法论 + 提炼固定规则；可注入失败模式 */
class SkillGenLLM implements LLMProvider {
  readonly id = 'skillgen';
  constructor(private fail = false) {}
  async chat(_msgs: ChatMessage[], _opts?: LLMOptions): Promise<string> {
    return '（生成）';
  }
  async *streamChat(_msgs: ChatMessage[], _opts?: LLMOptions): AsyncIterable<string> {
    yield '生成';
  }
  async structuredCall<T>(_system: string, _user: string, _schema: object): Promise<StructuredResult<T>> {
    if (this.fail) return { ok: false, message: 'llm down' };
    if (_system.includes('方法论分类')) {
      return { ok: true, data: { isMethodology: true, confidence: 0.9, reason: '含教学提问技巧' } as T };
    }
    return {
      ok: true,
      data: {
        purpose: '用提问引导自主思考',
        strategy: 'motivation',
        triggers: ['理解', '思考'],
        phrase: '很好，{topic} 再往前想一步：',
        interestBoost: 3,
        when: { concepts: ['理解'], signals: ['confused'], exclusiveGroup: 'probe', priority: 3 },
      } as T,
    };
  }
}

const baselineSkill: ActiveSkill = {
  id: 'socratic.core',
  engine: 'socratic',
  version: '0.1.0',
  enabled: true,
};

const thread: FrozenThread = {
  id: 't1',
  topic: '极限',
  turns: [
    { role: 'user', content: '导数是变化率' },
    { role: 'agent', content: '变化率想解决什么问题？' },
    { role: 'user', content: '瞬时变化' },
  ],
};

function tmpDir(): { dir: string; clean: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-skillgen-'));
  return { dir, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('classifyMethodology：LLM 判定方法论类', async () => {
  const d = await classifyMethodology(METHODOLOGY_MD, new SkillGenLLM(), { sourceFile: 'a.md' });
  assert.equal(d.isMethodology, true);
  assert.equal(d.llmJudged, true);
  assert.ok(d.confidence > 0.5);
});

test('classifyMethodology：无 LLM 启发式（方法论>阈值，非方法论<阈值）', async () => {
  const yes = await classifyMethodology(METHODOLOGY_MD);
  assert.equal(yes.isMethodology, true);
  assert.equal(yes.llmJudged, false);

  const no = await classifyMethodology(NON_METHODOLOGY_MD);
  assert.equal(no.isMethodology, false);
});

test('extractRules：LLM 提炼 / 失败降级默认', async () => {
  const ok = await extractRules(METHODOLOGY_MD, new SkillGenLLM());
  assert.equal(ok.purpose, '用提问引导自主思考');
  assert.deepEqual(ok.triggers, ['理解', '思考']);
  assert.ok(ok.phrase.includes('{topic}'));
  // when 应从 LLM 提炼并归一化
  assert.ok(ok.when, '应提炼 when');
  assert.deepEqual(ok.when?.signals, ['confused']);
  assert.equal(ok.when?.exclusiveGroup, 'probe');
  assert.equal(ok.when?.priority, 3);

  const degraded = await extractRules(METHODOLOGY_MD, new SkillGenLLM(true));
  assert.ok(degraded.purpose.includes('启发式'));
});

test('buildSkillCode 生成合法 TS 源码 + createSkillFromRules 叠加改写', async () => {
  const rules: SkillRules = {
    id: 'socratic.probe',
    engine: 'socratic',
    version: '0.1.0',
    purpose: '追问引导',
    strategy: 'motivation',
    triggers: ['理解'],
    phrase: '很好，{topic} 再想想：',
    interestBoost: 0,
  };
  const code = buildSkillCode(rules);
  assert.ok(code.includes('export function createSocraticProbeSkill()'));
  assert.ok(code.includes("id: 'socratic.probe'"));
  assert.ok(code.includes('RULES.phrase.replaceAll'));

  const skill = createSkillFromRules(rules);
  const m = new StrategyManager();
  const llm = new SkillGenLLM();
  m.register(createSocraticCoreSkill(llm));
  m.register(skill);
  const results = await m.run('socratic', {
    input: '我理解了导数的含义',
    concept: '导数',
    history: [],
    llm,
  });
  const final = [...results].reverse().map((r) => (r.engine === 'socratic' ? r.action : undefined)).find(Boolean);
  assert.ok(final && 'content' in final && final.content.includes('很好，我理解了导数的含义 再想想：'));
});

test('buildSkillCode：when/canHandle/exclusiveGroup 注入生成码', () => {
  const rules: SkillRules = {
    id: 'socratic.probe',
    engine: 'socratic',
    version: '0.1.0',
    purpose: '追问引导',
    strategy: 'motivation',
    triggers: ['理解'],
    phrase: '很好，{topic} 再想想：',
    interestBoost: 0,
    when: {
      concepts: ['理解'],
      signals: ['confused'],
      consecutive: { signal: 'mistake', count: 2 },
      profileMasteryLt: 0.5,
      exclusiveGroup: 'probe',
      priority: 3,
    },
  };
  const code = buildSkillCode(rules);
  assert.ok(code.includes("import { evaluateWhen, canHandleFor } from '../when.js'"));
  assert.ok(code.includes('exclusiveGroup: "probe"'));
  assert.ok(code.includes('signals: ["confused"]'));
  assert.ok(code.includes('consecutive: { signal: "mistake", count: 2 }'));
  assert.ok(code.includes('profileMasteryLt: 0.5'));
  assert.ok(code.includes('priority: 3'));
  // gate 挂载：when/canHandle/exclusiveGroup
  assert.ok(code.includes('when: (c: SkillContext) => evaluateWhen(RULES.when, c)'));
  assert.ok(code.includes('canHandle: (c: SkillContext) => canHandleFor(RULES.when, c)'));
  assert.ok(code.includes('exclusiveGroup: RULES.when.exclusiveGroup'));
});

test('createSkillFromRules + StrategyManager：when 门控只激活命中场景', async () => {
  const skill = createSkillFromRules(genRules({ when: { signals: ['confused'] } }));
  const m = new StrategyManager();
  m.register(skill);
  const base = { input: '我困惑了', concept: '导数', history: [] };
  const hit = await m.run('socratic', { ...base, signal: { signal: 'confused' } as never });
  assert.ok(hit.some((r) => r.engine === 'socratic' && r.meta.id === 'socratic.probe'), 'confused 应激活');

  const miss = await m.run('socratic', { ...base, signal: { signal: 'correct' } as never });
  assert.ok(!miss.some((r) => r.meta.id === 'socratic.probe'), 'correct 不应激活');
});

test('组合编排：互斥组内仅 canHandle 最优者执行', async () => {
  const m = new StrategyManager();
  // 同一 exclusiveGroup，priority 低 → 高，均命中 confused
  m.register(createSkillFromRules(genRules({ id: 'probe.low', when: { signals: ['confused'], exclusiveGroup: 'probe', priority: 1 } })));
  m.register(createSkillFromRules(genRules({ id: 'probe.high', when: { signals: ['confused'], exclusiveGroup: 'probe', priority: 5 } })));
  const results = await m.run('socratic', { input: '不懂', concept: '导数', history: [], signal: { signal: 'confused' } as never });
  const ids = results.map((r) => r.meta.id);
  assert.ok(ids.includes('probe.high'), '高优先级应执行');
  assert.ok(!ids.includes('probe.low'), '低优先级被互斥剔除');
});

test('createSkillFromRules：profile 侧产出兴趣增量', async () => {
  const skill = createSkillFromRules({
    id: 'profile.boost',
    engine: 'profile',
    version: '0.1.0',
    purpose: '兴趣激励',
    strategy: 'interest',
    triggers: [],
    phrase: '',
    interestBoost: 4,
  });
  const m = new StrategyManager();
  m.register(skill);
  const results = await m.run('profile', { input: 'x', concept: '代数', history: [] });
  const r = results.find((x) => x.engine === 'profile');
  assert.ok(r && r.engine === 'profile' && r.delta);
  assert.equal(r.delta.interestDelta?.['代数'], 4);
});

test('generateFromKnowledge：写盘 TS + 说明文档 + id 派生', async () => {
  const { dir, clean } = tmpDir();
  try {
    const srcDir = path.join(dir, 'generated');
    const docDir = path.join(dir, 'docs');
    const draft = await generateFromKnowledge(
      { content: METHODOLOGY_MD, engine: 'socratic', id: 'socratic.probe', sourceFile: 'probe.md', version: '0.1.0' },
      { write: true, srcDir, docDir },
      new SkillGenLLM(),
    );
    assert.ok(draft.srcPath && fs.existsSync(draft.srcPath), 'TS 源码应落盘');
    assert.ok(draft.docPath && fs.existsSync(draft.docPath), '说明文档应落盘');
    assert.equal(idFromFilename('socratic.probe.md'), 'socratic_probe');
  } finally {
    clean();
  }
});

test('runSkillGenPipeline：方法论 → 生成 + 注册工厂 + 评测门禁 verdict', async () => {
  const { dir, clean } = tmpDir();
  try {
    const srcDir = path.join(dir, 'generated');
    const outDir = path.join(dir, 'evals');
    const res = await runSkillGenPipeline({
      content: METHODOLOGY_MD,
      engine: 'socratic',
      id: 'socratic.probe',
      sourceFile: 'probe.md',
      baselineSkills: [baselineSkill],
      threads: [thread],
      judgeProvider: new SkillGenLLM(),
      outputDir: outDir,
      write: true,
      srcDir,
    });
    assert.ok(res.draft, '方法论内容应生成草案');
    assert.ok(res.evalReport, '应产出评测报告');
    assert.ok(res.evalReport.threadsReplayed >= 1);
    // 生成的 TS 源码应已落盘（write: true）
    assert.ok(fs.existsSync(path.join(srcDir, 'socratic.probe.ts')));
  } finally {
    clean();
  }
});

test('runSkillGenPipeline：非方法论 → 不生成', async () => {
  const { dir, clean } = tmpDir();
  try {
    const res = await runSkillGenPipeline({
      content: NON_METHODOLOGY_MD,
      engine: 'socratic',
      id: 'hist.note',
      baselineSkills: [baselineSkill],
      threads: [thread],
      // 不传 LLM → 启发式判定；本内容非方法论 → 不生成
      outputDir: path.join(dir, 'evals'),
      write: false,
    });
    assert.equal(res.draft, null);
    assert.equal(res.decision.isMethodology, false);
  } finally {
    clean();
  }
});

test('scanKnowledgeDirForSkills：仅方法论类 md 产出草案', async () => {
  const { dir, clean } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'method.md'), METHODOLOGY_MD, 'utf-8');
    fs.writeFileSync(path.join(dir, 'history.md'), NON_METHODOLOGY_MD, 'utf-8');
    const metas = await scanKnowledgeDirForSkills({ dir, engine: 'socratic', write: false });
    assert.equal(metas.length, 1, '仅方法论类产出草案');
    assert.equal(metas[0].id, 'method');
  } finally {
    clean();
  }
});

test('ReflectionEngine 接入 skillGen：报告记录草案且不改引擎', async () => {
  const { dir, clean } = tmpDir();
  try {
    // 写入一份方法论类知识 md 供反思扫描
    fs.writeFileSync(path.join(dir, 'method.md'), METHODOLOGY_MD, 'utf-8');
    const store = new SqliteStorage(path.join(dir, 'learner.db'));
    const engine = new ReflectionEngine(new SkillGenLLM(), store);
    const { report } = await engine.run(
      'manual',
      {
        outputDir: dir,
        skillGen: {
          knowledgeDir: dir,
          engine: 'socratic',
          llm: new SkillGenLLM(),
          write: false,
        },
      },
    );
    assert.ok(report.skillDrafts && report.skillDrafts.length >= 1, '应生成草案元信息');
    assert.equal(report.status, 'draft');
    store.close();
  } finally {
    clean();
  }
});

// ---- §8.2.1 应用步骤 ----

const genRules = (over: Partial<SkillRules> = {}): SkillRules => ({
  id: 'socratic.probe',
  engine: 'socratic',
  version: '0.1.0',
  purpose: '追问引导',
  strategy: 'motivation',
  triggers: ['理解'],
  phrase: '很好，{topic} 再想想：',
  interestBoost: 0,
  ...over,
});

test('applyGeneratedSkill：写注册表 + 幂等覆盖 + 可回滚', async () => {
  const { dir, clean } = tmpDir();
  try {
    const info = applyGeneratedSkill(genRules(), { dir });
    assert.equal(info.id, 'socratic.probe');

    let list = listAppliedSkills({ dir });
    assert.equal(list.length, 1);
    assert.equal(list[0].version, '0.1.0');
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'active.json')));

    // 幂等：同 id+engine 以新版本覆盖，不重复
    applyGeneratedSkill(genRules({ version: '0.2.0' }), { dir });
    list = listAppliedSkills({ dir });
    assert.equal(list.length, 1, '同 id 覆盖不累积');
    assert.equal(list[0].version, '0.2.0');

    // 移除
    assert.equal(removeAppliedSkill('socratic.probe', 'socratic', { dir }), true);
    assert.equal(listAppliedSkills({ dir }).length, 0);
  } finally {
    clean();
  }
});

test('createEngineManagerFromRegistry：默认组合 + 已应用 skill 叠加生效', async () => {
  const { dir, clean } = tmpDir();
  try {
    const llm = new SkillGenLLM();
    // 未应用任何 skill → 仅默认 core
    let m = createEngineManagerFromRegistry('socratic', { dir, llm });
    assert.ok(m.list('socratic').some((s) => s.id === 'socratic.core'));

    // 应用一个叠加 skill 后，装配 manager 应包含它并叠加改写 final 动作
    applyGeneratedSkill(genRules(), { dir });
    m = createEngineManagerFromRegistry('socratic', { dir, llm });
    assert.ok(m.list('socratic').some((s) => s.id === 'socratic.probe' && s.enabled));

    const results = await m.run('socratic', {
      input: '我理解了导数的含义',
      concept: '导数',
      history: [],
      llm,
    });
    const final = [...results]
      .reverse()
      .map((r) => (r.engine === 'socratic' ? r.action : undefined))
      .find(Boolean);
    assert.ok(final && 'content' in final && final.content.includes('很好，我理解了导数的含义 再想想：'));
  } finally {
    clean();
  }
});

test('createEngineManagerFromRegistry：按引擎过滤（profile 不混入 socratic）', async () => {
  const { dir, clean } = tmpDir();
  try {
    applyGeneratedSkill(genRules(), { dir }); // socratic
    applyGeneratedSkill(
      genRules({ id: 'profile.boost', engine: 'profile', phrase: '' }),
      { dir },
    );
    const socratic = createEngineManagerFromRegistry('socratic', { dir });
    const profile = createEngineManagerFromRegistry('profile', { dir });
    assert.ok(socratic.list('socratic').some((s) => s.id === 'socratic.probe'));
    assert.ok(!socratic.list('socratic').some((s) => s.id === 'profile.boost'));
    assert.ok(profile.list('profile').some((s) => s.id === 'profile.boost'));
    assert.ok(!profile.list('profile').some((s) => s.id === 'socratic.probe'));
  } finally {
    clean();
  }
});
