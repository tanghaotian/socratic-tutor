import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { ProfileEngine } from '../src/engines/profile.js';
import { SocraticEngine } from '../src/engines/socratic.js';
import { SignalParser } from '../src/engines/signal.js';
import { recordTurn } from '../src/engines/conversation.js';
import { registerMcpServer } from '../src/mcp/index.js';
import { createStrategyManagerFromRegistry } from '../src/engines/plans/index.js';
import { StudyPlanEngine } from '../src/engines/plans/study-plan.js';
import { ReviewEngine } from '../src/engines/plans/review.js';
import { ReflectionEngine } from '../src/engines/reflection.js';
import { ResourceEngine } from '../src/engines/resource.js';
import { MockSearchProvider } from '../src/providers/index.js';
import type { McpContext } from '../src/mcp/context.js';
import type { AppConfig } from '../src/config.js';
import type {
  LLMProvider,
  ChatMessage,
  LLMOptions,
  StructuredResult,
  AnswerSignal,
  ReminderProvider,
  ProviderContainer,
} from '../src/providers/index.js';

/**
 * 桩 LLM：structuredCall 始终失败 → SignalParser 走规则兜底（无需真实 key、完全确定）。
 * 兜底规则见 src/engines/signal.ts `fallbackSignal`：
 * 空/长度≤4/含「不知道|不会|不懂|不确定」→ confused，否则 correct。
 */
class StubLLM implements LLMProvider {
  readonly id = 'stub';
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    return '（引导语）';
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    yield '（引导语）';
  }
  async structuredCall<T>(_s: string, _u: string, _schema: object): Promise<StructuredResult<T>> {
    return { ok: false, data: null as T };
  }
}

/** 桩 LLM：structuredCall 返回脚本化信号序列（验证「信号进入会话历史」的完整链路） */
class ScriptedLLM implements LLMProvider {
  readonly id = 'scripted';
  constructor(private signals: AnswerSignal[]) {}
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    return '（引导语）';
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    yield '（引导语）';
  }
  async structuredCall<T>(): Promise<StructuredResult<T>> {
    const signal = this.signals.shift() ?? 'correct';
    return {
      ok: true,
      data: { signal, confidence: 0.9, concept_ids: [], error_categories: [] } as T,
    };
  }
}

class StubReminder implements ReminderProvider {
  readonly id = 'web' as const;
  async notify(): Promise<void> {}
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-conv-'));
}

function cleanup(dir: string, store: SqliteStorage): void {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildCfg(dir: string): AppConfig {
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
  } as unknown as AppConfig;
}

function buildMcpContext(dir: string, store: SqliteStorage, llm: LLMProvider, cfg: AppConfig): McpContext {
  const profile = new ProfileEngine(store);
  const knowledge = path.join(dir, 'knowledge', 'skills');
  fs.mkdirSync(knowledge, { recursive: true });
  return {
    cfg,
    providers: { getLLM: () => llm, getJudge: () => llm } as unknown as ProviderContainer,
    store,
    learnerId: 'local-user',
    parser: new SignalParser(llm),
    profile,
    socratic: new SocraticEngine(llm),
    reflection: new ReflectionEngine(llm, store),
    resource: new ResourceEngine(llm, new MockSearchProvider(), knowledge),
    planEngine: new StudyPlanEngine(store, profile),
    reviewEngine: new ReviewEngine(store, profile),
    remind: new StubReminder(),
    strategies: createStrategyManagerFromRegistry(dir, llm),
  };
}

// ---- 存储层：会话与信号历史 ----

test('会话落库：listRecentSignals 按主题隔离且旧→新排序', () => {
  const dir = tmpDir();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  try {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    store.appendConversationTurn({ learnerId: 'u', topicId: '微积分', userText: 'a', signal: 'correct', createdAt: at(0) });
    store.appendConversationTurn({ learnerId: 'u', topicId: '微积分', userText: 'b', signal: 'confused', createdAt: at(1) });
    store.appendConversationTurn({ learnerId: 'u', topicId: '微积分', userText: 'c', signal: 'confused', createdAt: at(2) });
    // 另一主题：不应污染
    store.appendConversationTurn({ learnerId: 'u', topicId: '线性代数', userText: 'x', signal: 'divergent', createdAt: at(3) });

    assert.deepEqual(store.listRecentSignals('u', '微积分'), ['correct', 'confused', 'confused']);
    assert.deepEqual(store.listRecentSignals('u', '线性代数'), ['divergent']);
    // 未指定主题与指定主题是两个独立会话
    assert.deepEqual(store.listRecentSignals('u'), []);
    assert.equal(store.listConversationTurns('u', '微积分').length, 3);
    assert.equal(store.listConversationTurns('u', '微积分')[2].userText, 'c');
  } finally {
    cleanup(dir, store);
  }
});

test('会话落库：listRecentSignals 遵守 limit（只取最近 N 条，仍为旧→新）', () => {
  const dir = tmpDir();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  try {
    for (let i = 0; i < 5; i++) {
      store.appendConversationTurn({
        learnerId: 'u',
        topicId: 't',
        userText: `turn-${i}`,
        signal: i % 2 === 0 ? 'correct' : 'confused',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    // i%2===0 → correct，故最后两条为 i=4(correct)、i=3(confused)；取最近 2 条反转为旧→新
    assert.deepEqual(store.listRecentSignals('u', 't', 2), ['confused', 'correct']);
  } finally {
    cleanup(dir, store);
  }
});

// ---- 编排层：recordTurn 注入真实 history ----

test('recordTurn 把历史注入引擎：会话第 3 轮拿到前两轮信号（长度与顺序均正确）', async () => {
  const dir = tmpDir();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new ScriptedLLM(['confused', 'confused', 'confused']);
  const profile = new ProfileEngine(store);
  const deps = { store, parser: new SignalParser(llm), profile, socratic: new SocraticEngine(llm) };
  try {
    const first = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '第一条' });
    assert.equal(first.action.type, 'ask', '首轮 confused → focus 追问');

    const second = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '第二条' });
    assert.equal(second.action.type, 'hint', '连续两次 confused → hint（BUG-004 前永不触发）');

    const third = await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '第三条' });
    assert.equal(third.action.type, 'hint', '连续三次仍为 hint');

    // 本轮 signal 不得出现在自己的 history 中：3 轮过后历史恰好 3 条
    assert.deepEqual(store.listRecentSignals('u', '微积分'), ['confused', 'confused', 'confused']);
    assert.equal(store.listConversationTurns('u', '微积分').length, 3);
  } finally {
    cleanup(dir, store);
  }
});

test('recordTurn 换主题后连续判定重置（不同主题互不串扰）', async () => {
  const dir = tmpDir();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new ScriptedLLM(['confused', 'confused', 'confused']);
  const profile = new ProfileEngine(store);
  const deps = { store, parser: new SignalParser(llm), profile, socratic: new SocraticEngine(llm) };
  try {
    await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '1' });
    await recordTurn(deps, { learnerId: 'u', topicId: '微积分', userText: '2' });
    // 换主题：历史为空 → 回到 focus，而不是承接上一主题的 hint
    const other = await recordTurn(deps, { learnerId: 'u', topicId: '线性代数', userText: '3' });
    assert.equal(other.action.type, 'ask');
    if (other.action.type === 'ask') assert.equal(other.action.strategy, 'focus');
  } finally {
    cleanup(dir, store);
  }
});

test('recordTurn 记录学习事件与可落库文本', async () => {
  const dir = tmpDir();
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
    assert.ok(turn.agentText.length > 0, 'agent 文本应落库');
  } finally {
    cleanup(dir, store);
  }
});

// ---- 端到端：经 HTTP 边界验证（HANDOFF 纪律：新增路由能力必须有 app.inject 用例） ----

test('回归 BUG-004：MCP chat_socratic 经 HTTP 连续两轮 confused → hint（history 不再恒为空）', async () => {
  const dir = tmpDir();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new StubLLM(); // structuredCall 失败 → 规则兜底，短句必为 confused
  const cfg = buildCfg(dir);
  const ctx = buildMcpContext(dir, store, llm, cfg);
  const app = Fastify();
  try {
    registerMcpServer(app, ctx, cfg);
    // 握手
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
    });
    const sid = init.headers['mcp-session-id'] as string;
    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/mcp', headers: { 'mcp-session-id': sid }, payload: payload as object });

    const call = async (id: number, text: string) => {
      const res = await post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'chat_socratic', arguments: { text, topicId: '微积分' } },
      });
      assert.equal(res.statusCode, 200);
      return res.json().result.structuredContent as { reply: { type: string; strategy?: string }; signal: string };
    };

    const first = await call(1, '不懂');
    assert.equal(first.signal, 'confused');
    assert.equal(first.reply.type, 'ask', '首轮 confused → focus 追问');
    assert.equal(first.reply.strategy, 'focus');

    const second = await call(2, '不会');
    assert.equal(second.signal, 'confused');
    assert.equal(second.reply.type, 'hint', '连续两次 confused 应升级为 hint（修复前恒为 focus）');

    // 会话历史确实落库
    assert.deepEqual(store.listRecentSignals('local-user', '微积分'), ['confused', 'confused']);
  } finally {
    await app.close();
    cleanup(dir, store);
  }
});

test('回归 BUG-004：MCP chat_socratic 换主题后回到 focus（会话按主题隔离）', async () => {
  const dir = tmpDir();
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new StubLLM();
  const cfg = buildCfg(dir);
  const ctx = buildMcpContext(dir, store, llm, cfg);
  const app = Fastify();
  try {
    registerMcpServer(app, ctx, cfg);
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
    });
    const sid = init.headers['mcp-session-id'] as string;
    const call = async (id: number, text: string, topicId: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'mcp-session-id': sid },
        payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'chat_socratic', arguments: { text, topicId } } },
      });
      return res.json().result.structuredContent as { reply: { type: string; strategy?: string } };
    };

    await call(1, '不懂', '微积分');
    await call(2, '不会', '微积分');
    const other = await call(3, '不懂', '线性代数');
    assert.equal(other.reply.type, 'ask', '新主题首轮不应继承另一主题的 hint');
    assert.equal(other.reply.strategy, 'focus');
  } finally {
    await app.close();
    cleanup(dir, store);
  }
});
