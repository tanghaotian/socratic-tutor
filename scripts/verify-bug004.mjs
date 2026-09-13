/**
 * BUG-004 修复的进程内验证脚本（对 dist 编译产物断言）。
 *
 * 存在理由：本机沙箱下 `node:test` 运行器必须 spawn 子进程（被拦截，EPERM），
 * 故 `npm test` 无法运行。本脚本不使用任何子进程，直接对 `npm run build` 的产物做断言，
 * 与 test/conversation.test.ts 覆盖同一组行为（存储层排序/隔离、编排层 history 注入、HTTP 端到端）。
 *
 * 用法：npm run build && node scripts/verify-bug004.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SqliteStorage } = await import('../dist/storage/sqlite.js');
const { ProfileEngine } = await import('../dist/engines/profile.js');
const { SocraticEngine } = await import('../dist/engines/socratic.js');
const { SignalParser } = await import('../dist/engines/signal.js');
const { recordTurn } = await import('../dist/engines/conversation.js');
const { registerMcpServer } = await import('../dist/mcp/index.js');
const { StudyPlanEngine } = await import('../dist/engines/plans/study-plan.js');
const { ReviewEngine } = await import('../dist/engines/plans/review.js');
const { ReflectionEngine } = await import('../dist/engines/reflection.js');
const { ResourceEngine } = await import('../dist/engines/resource.js');
const { MockSearchProvider } = await import('../dist/providers/index.js');
const { createStrategyManagerFromRegistry } = await import('../dist/engines/plans/index.js');
const Fastify = (await import('fastify')).default;

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, message: e?.message ?? String(e) });
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}

/** 规则兜底：短句/含「不会|不懂」→ confused（无需真实 LLM） */
class StubLLM {
  id = 'stub';
  async chat() {
    return '（引导语）';
  }
  async *streamChat() {
    yield '（引导语）';
  }
  async structuredCall() {
    return { ok: false, data: null };
  }
}

class ScriptedLLM {
  id = 'scripted';
  constructor(signals) {
    this.signals = signals;
  }
  async chat() {
    return '（引导语）';
  }
  async *streamChat() {
    yield '（引导语）';
  }
  async structuredCall() {
    const signal = this.signals.shift() ?? 'correct';
    return { ok: true, data: { signal, confidence: 0.9, concept_ids: [], error_categories: [] } };
  }
}

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bug004-'));
function rm(dir, store) {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

function buildCfg(dir) {
  return {
    storage: { dir },
    tracing: { enabled: false },
    conversation: { maxHistory: 20 },
    plan: {
      reviewWeights: { goalCompletion: 0.4, signalAccuracy: 0.2, frequencyRate: 0.2, masteryChange: 0.2 },
      anchorStreak: 2,
      anchorThreshold: 0.5,
    },
    mcp: { enabled: true, transport: 'http' },
  };
}

function buildMcpContext(dir, store, llm, cfg) {
  const profile = new ProfileEngine(store);
  const knowledge = path.join(dir, 'knowledge', 'skills');
  fs.mkdirSync(knowledge, { recursive: true });
  return {
    cfg,
    providers: { getLLM: () => llm, getJudge: () => llm },
    store,
    learnerId: 'local-user',
    parser: new SignalParser(llm),
    profile,
    socratic: new SocraticEngine(llm),
    reflection: new ReflectionEngine(llm, store),
    resource: new ResourceEngine(llm, new MockSearchProvider(), knowledge),
    planEngine: new StudyPlanEngine(store, profile),
    reviewEngine: new ReviewEngine(store, profile),
    remind: { id: 'web', async notify() {} },
    strategies: createStrategyManagerFromRegistry(dir, llm),
  };
}

console.log('\n[1] 存储层：会话与信号历史\n');

await check('listRecentSignals 按主题隔离且旧→新排序', () => {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  try {
    store.appendConversationTurn({ learnerId: 'u', topicId: '微积分', userText: 'a', signal: 'correct', createdAt: at(0) });
    store.appendConversationTurn({ learnerId: 'u', topicId: '微积分', userText: 'b', signal: 'confused', createdAt: at(1) });
    store.appendConversationTurn({ learnerId: 'u', topicId: '微积分', userText: 'c', signal: 'confused', createdAt: at(2) });
    store.appendConversationTurn({ learnerId: 'u', topicId: '线性代数', userText: 'x', signal: 'divergent', createdAt: at(3) });
    assert.deepEqual(store.listRecentSignals('u', '微积分'), ['correct', 'confused', 'confused']);
    assert.deepEqual(store.listRecentSignals('u', '线性代数'), ['divergent']);
    assert.deepEqual(store.listRecentSignals('u'), []);
    assert.equal(store.listConversationTurns('u', '微积分').length, 3);
  } finally {
    rm(dir, store);
  }
});

await check('listRecentSignals 遵守 limit（取最近 N 条，仍旧→新）', () => {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  try {
    for (let i = 0; i < 5; i++) {
      store.appendConversationTurn({
        learnerId: 'u',
        topicId: 't',
        userText: `turn-${i}`,
        signal: i % 2 === 0 ? 'correct' : 'confused',
        createdAt: at(i),
      });
    }
    // i%2===0 → correct，最后两条为 i=4(correct)、i=3(confused)；取最近 2 条反转为旧→新
    assert.deepEqual(store.listRecentSignals('u', 't', 2), ['confused', 'correct']);
  } finally {
    rm(dir, store);
  }
});

console.log('\n[2] 编排层：recordTurn 注入真实 history\n');

await check('连续两次 confused → hint（修复前恒为 focus）', async () => {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new ScriptedLLM(['confused', 'confused', 'confused']);
  const profile = new ProfileEngine(store);
  const deps = { store, parser: new SignalParser(llm), profile, socratic: new SocraticEngine(llm) };
  try {
    const first = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '第一条' });
    assert.equal(first.action.type, 'ask');
    const second = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '第二条' });
    assert.equal(second.action.type, 'hint');
    const third = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '第三条' });
    assert.equal(third.action.type, 'hint');
    // 本轮 signal 不在自己的 history 中
    assert.deepEqual(store.listRecentSignals('u', '微积分'), ['confused', 'confused', 'confused']);
  } finally {
    rm(dir, store);
  }
});

await check('连续两次 correct → self_eval', async () => {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new ScriptedLLM(['correct', 'correct']);
  const profile = new ProfileEngine(store);
  const deps = { store, parser: new SignalParser(llm), profile, socratic: new SocraticEngine(llm) };
  try {
    await recordTurn(deps, { learnerId: 'u', topicId: 't', userText: '1' });
    const second = await recordTurn(deps, { learnerId: 'u', topicId: 't', userText: '2' });
    assert.equal(second.action.type, 'assess_self');
  } finally {
    rm(dir, store);
  }
});

await check('换主题后连续判定重置', async () => {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new ScriptedLLM(['confused', 'confused', 'confused']);
  const profile = new ProfileEngine(store);
  const deps = { store, parser: new SignalParser(llm), profile, socratic: new SocraticEngine(llm) };
  try {
    await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '1' });
    await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '2' });
    const other = await recordTurn(deps, { learnerId: 'u', topicId: '线性代数', userText: '3' });
    assert.equal(other.action.type, 'ask');
    assert.equal(other.action.strategy, 'focus');
  } finally {
    rm(dir, store);
  }
});

await check('学习事件与可落库文本均正确', async () => {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new ScriptedLLM(['mistake']);
  const profile = new ProfileEngine(store);
  const deps = { store, parser: new SignalParser(llm), profile, socratic: new SocraticEngine(llm) };
  try {
    const { action } = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '错了' });
    assert.equal(action.type, 'evaluate');
    assert.equal(store.listLearningEvents('u').length, 1);
    const turn = store.listConversationTurns('u', '微积分')[0];
    assert.equal(turn.signal, 'mistake');
    assert.ok(turn.agentText.length > 0);
  } finally {
    rm(dir, store);
  }
});

console.log('\n[3] 端到端：MCP over HTTP（app.inject）\n');

async function mcpHarness() {
  const dir = mkTmp();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const cfg = buildCfg(dir);
  const ctx = buildMcpContext(dir, store, new StubLLM(), cfg);
  const app = Fastify();
  registerMcpServer(app, ctx, cfg);
  const init = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
  });
  assert.equal(init.statusCode, 200, 'initialize 应成功');
  const sid = init.headers['mcp-session-id'];
  assert.ok(sid, '必须返回 Mcp-Session-Id');
  const chat = async (id, text, topicId) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sid },
      payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'chat_socratic', arguments: { text, topicId } } },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.result?.content?.[0]?.type === 'text', 'tools/call 应返回规范 content');
    return body.result.structuredContent;
  };
  return { app, store, dir, chat };
}

await check('HTTP：连续两轮 confused → hint，且会话已落库', async () => {
  const h = await mcpHarness();
  try {
    const first = await h.chat(1, '不懂', '微积分');
    assert.equal(first.signal, 'confused');
    assert.equal(first.reply.type, 'ask');
    assert.equal(first.reply.strategy, 'focus');
    const second = await h.chat(2, '不会', '微积分');
    assert.equal(second.signal, 'confused');
    assert.equal(second.reply.type, 'hint');
    assert.deepEqual(h.store.listRecentSignals('local-user', '微积分'), ['confused', 'confused']);
  } finally {
    await h.app.close();
    rm(h.dir, h.store);
  }
});

await check('HTTP：换主题后回到 focus（按主题隔离）', async () => {
  const h = await mcpHarness();
  try {
    await h.chat(1, '不懂', '微积分');
    await h.chat(2, '不会', '微积分');
    const other = await h.chat(3, '不懂', '线性代数');
    assert.equal(other.reply.type, 'ask');
    assert.equal(other.reply.strategy, 'focus');
  } finally {
    await h.app.close();
    rm(h.dir, h.store);
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
