import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { ProfileEngine } from '../src/engines/profile.js';
import { ReflectionEngine } from '../src/engines/reflection.js';
import { SocraticEngine } from '../src/engines/socratic.js';
import { SignalParser } from '../src/engines/signal.js';
import { ResourceEngine } from '../src/engines/resource.js';
import { MockSearchProvider } from '../src/providers/index.js';
import { StudyPlanEngine, ReviewEngine, createStrategyManagerFromRegistry } from '../src/engines/plans/index.js';
import { handleJsonRpc, registerMcpServer } from '../src/mcp/index.js';
import { listTools, callTool } from '../src/mcp/tools.js';
import { JsonRpcErrorCode, MCP_LATEST_PROTOCOL_VERSION, type JsonRpcResponse } from '../src/mcp/types.js';
import type { McpContext } from '../src/mcp/context.js';
import type { AppConfig } from '../src/config.js';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult, ReminderProvider, ProviderContainer } from '../src/providers/index.js';

/** 桩 LLM：structuredCall 一律失败 → 触发启发式降级（无需真实 key） */
class StubLLM implements LLMProvider {
  readonly id = 'stub';
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    return 'ok';
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    yield 'ok';
  }
  async structuredCall<T>(_s: string, _u: string, _schema: object): Promise<StructuredResult<T>> {
    return { ok: false, data: null as T };
  }
}

class StubReminder implements ReminderProvider {
  readonly id = 'web' as const;
  async notify(): Promise<void> {}
}

function buildProviderContainer(llm: LLMProvider): ProviderContainer {
  return {
    getLLM: () => llm,
    getJudge: () => llm,
  } as unknown as ProviderContainer;
}

function setup(overrides: { mcpEnabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-mcp-'));
  const store = new SqliteStorage(path.join(dir, 'learner.db'));
  const llm = new StubLLM();
  const profile = new ProfileEngine(store);
  const knowledge = path.join(dir, 'knowledge', 'skills');
  fs.mkdirSync(knowledge, { recursive: true });

  const cfg = {
    storage: { dir },
    plan: {
      reviewWeights: { goalCompletion: 0.4, signalAccuracy: 0.2, frequencyRate: 0.2, masteryChange: 0.2 },
      anchorStreak: 2,
      anchorThreshold: 0.5,
    },
    mcp: { enabled: overrides.mcpEnabled ?? true, transport: 'http' },
  } as unknown as AppConfig;

  const ctx: McpContext = {
    cfg,
    providers: buildProviderContainer(llm),
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
  return { dir, store, ctx };
}

function cleanup(s: { dir: string; store: SqliteStorage }) {
  s.store.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
}

/** 断言是成功响应并返回其 result（通知返回 null，视为失败） */
function okResult(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res, '不应是通知（null）');
  if ('error' in res) assert.fail(JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}

/**
 * MCP `tools/call` 的结果按规范包装为 { content, structuredContent }。
 * 取回工具的业务返回值（structuredContent）。
 */
function toolPayload(res: JsonRpcResponse | null): Record<string, unknown> {
  const result = okResult(res);
  assert.ok(Array.isArray(result.content), 'tools/call 结果必须含 content 数组');
  const first = (result.content as { type: string; text: string }[])[0];
  assert.equal(first.type, 'text');
  assert.ok(first.text.length > 0, 'content 文本块不应为空');
  assert.ok(result.structuredContent, '结构化结果应同时提供');
  return result.structuredContent as Record<string, unknown>;
}

test('AC1 tools/list 返回 7 个工具（MCP 规范：{ tools: [...] }）', () => {
  const { tools } = listTools();
  assert.equal(tools.length, 7);
  const names = tools.map((t) => t.name);
  for (const n of ['chat_socratic', 'get_learner_profile', 'trigger_reflection', 'confirm_upgrade', 'summarize_resource', 'plan_generate', 'review_generate']) {
    assert.ok(names.includes(n), `缺工具 ${n}`);
  }
  // MCP Tool 结构：每个工具 inputSchema 为对象 schema 且 strict（additionalProperties:false）
  for (const t of tools) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 应声明 additionalProperties:false`);
    assert.ok(t.inputSchema.properties);
    // 声明 required 的字段必须出现在 properties 中
    if (t.inputSchema.required) {
      for (const k of t.inputSchema.required) {
        assert.ok(k in t.inputSchema.properties, `${t.name} required[${k}] 需在 properties 中`);
      }
    }
  }
});

test('AC1 tools/list 经 JSON-RPC 返回 7 项且结构合规', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, s.ctx);
    if ('error' in res) assert.fail('不应报错');
    const { tools } = res.result as { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] };
    assert.equal(tools.length, 7);
    for (const t of tools) {
      assert.equal(t.inputSchema.additionalProperties, false);
    }
  } finally {
    cleanup(s);
  }
});

test('AC2 chat_socratic 对话并记录学习事件', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat_socratic', arguments: { text: '我不会微积分' } } },
      s.ctx,
    );
    const r = toolPayload(res) as unknown as { reply: { type: string }; signal: string };
    assert.ok(['ask', 'ask', 'explain'].includes(r.reply.type)); // 教学动作
    assert.equal(r.signal, 'confused'); // '我不会' → confused
    // 学习事件已记录
    const events = s.store.listLearningEvents('local-user').length;
    assert.ok(events >= 1);
  } finally {
    cleanup(s);
  }
});

test('AC2 get_learner_profile 读取画像', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_learner_profile', arguments: {} } }, s.ctx);
    assert.ok((toolPayload(res) as { profile: object }).profile);
  } finally {
    cleanup(s);
  }
});

test('AC2 trigger_reflection 生成反思报告', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'trigger_reflection', arguments: {} } }, s.ctx);
    const r = toolPayload(res) as unknown as { report: { id: string; status: string } };
    assert.equal(r.report.status, 'draft');
  } finally {
    cleanup(s);
  }
});

test('AC2 confirm_upgrade 确认反思报告', async () => {
  const s = setup();
  try {
    const runRes = await handleJsonRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'trigger_reflection', arguments: {} } }, s.ctx);
    const { report } = toolPayload(runRes) as unknown as { report: { id: string } };
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'confirm_upgrade', arguments: { id: report.id } } }, s.ctx);
    assert.equal((toolPayload(res) as { status: string }).status, 'confirmed');
  } finally {
    cleanup(s);
  }
});

test('AC2 summarize_resource 总结资料并写 knowledge/skills', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'summarize_resource', arguments: { sourceType: 'paper', content: '费曼学习法的核心步骤与适用场景。', sourceTitle: 'Feynman Technique' } } },
      s.ctx,
    );
    if ('error' in res) assert.fail(JSON.stringify(res.error));
    const r = toolPayload(res) as unknown as { summary: { title: string }; skillMarkdownPath: string };
    assert.ok(r.skillMarkdownPath);
    assert.ok(fs.existsSync(r.skillMarkdownPath));
  } finally {
    cleanup(s);
  }
});

test('AC2 plan_generate 与 review_generate 生成计划与复盘', async () => {
  const s = setup();
  try {
    const planRes = await handleJsonRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'plan_generate', arguments: { topicId: '微积分' } } }, s.ctx);
    const { plan } = toolPayload(planRes) as unknown as { plan: { id: string; status: string } };
    assert.equal(plan.status, 'draft');

    const reviewRes = await handleJsonRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'review_generate', arguments: { planId: plan.id } } }, s.ctx);
    const r = toolPayload(reviewRes) as unknown as { review: { status: string; totalScore?: number } };
    assert.equal(r.review.status, 'draft');
  } finally {
    cleanup(s);
  }
});

test('AC3 非法 method → MethodNotFound', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 10, method: 'nope' }, s.ctx);
    assert.ok('error' in res);
    assert.equal(res.error.code, JsonRpcErrorCode.MethodNotFound);
  } finally {
    cleanup(s);
  }
});

test('AC3 未知工具 → InvalidParams（规范 §Tools 示例：-32602）', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }, s.ctx);
    assert.ok(res && 'error' in res);
    assert.equal(res.error.code, JsonRpcErrorCode.InvalidParams);
  } finally {
    cleanup(s);
  }
});

test('AC3 缺参 → InvalidParams', async () => {
  const s = setup();
  try {
    const res = await handleJsonRpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'chat_socratic', arguments: {} } }, s.ctx);
    assert.ok('error' in res);
    assert.equal(res.error.code, JsonRpcErrorCode.InvalidParams);
  } finally {
    cleanup(s);
  }
});

test('AC3 非对象 body → InvalidRequest；非法 jsonrpc → InvalidRequest', async () => {
  const s = setup();
  try {
    const a = await handleJsonRpc([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], s.ctx);
    assert.ok('error' in a);
    assert.equal(a.error.code, JsonRpcErrorCode.InvalidRequest);
    const b = await handleJsonRpc({ jsonrpc: '1.0', id: 1, method: 'tools/list' }, s.ctx);
    assert.ok('error' in b);
    assert.equal(b.error.code, JsonRpcErrorCode.InvalidRequest);
  } finally {
    cleanup(s);
  }
});

test('AC4 MCP_ENABLED=false 时 registerMcpServer 不注册 /mcp 路由', async () => {
  const s = setup({ mcpEnabled: false });
  const app = Fastify();
  try {
    registerMcpServer(app, s.ctx, s.ctx.cfg);
    assert.equal(app.hasRoute({ method: 'POST', url: '/mcp' }), false, '禁用时不应注册 /mcp');
    // 走真实 HTTP 边界：未注册时应为 404（而非返回 {}）
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    cleanup(s);
  }
});

test('AC4 MCP_ENABLED=true 时 registerMcpServer 注册 /mcp 路由', async () => {
  const s = setup();
  const app = Fastify();
  try {
    registerMcpServer(app, s.ctx, s.ctx.cfg);
    assert.equal(app.hasRoute({ method: 'POST', url: '/mcp' }), true);

    // Streamable HTTP：POST /mcp 必须先 initialize；未握手直接调用应被拒（400）
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(res.statusCode, 400, '未 initialize 的请求应被拒绝');
  } finally {
    await app.close();
    cleanup(s);
  }
});

/** 完成 MCP 生命周期握手，返回 sessionId 与一个已带会话头的请求函数 */
async function handshake(app: ReturnType<typeof Fastify>): Promise<{
  sessionId: string;
  post: (payload: unknown) => Promise<{ statusCode: number; json: () => any; body: string; headers: Record<string, unknown> }>;
}> {
  // 1) initialize
  const init = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { accept: 'application/json, text/event-stream' },
    payload: {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    },
  });
  assert.equal(init.statusCode, 200, 'initialize 应成功');
  const sessionId = init.headers['mcp-session-id'] as string;
  assert.ok(sessionId, 'initialize 响应必须返回 Mcp-Session-Id 头');
  assert.equal(init.json().result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);

  // 2) notifications/initialized（通知 → 202 且无响应体）
  const notified = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': MCP_LATEST_PROTOCOL_VERSION },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(notified.statusCode, 202, '通知应返回 202');

  return {
    sessionId,
    post: (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': MCP_LATEST_PROTOCOL_VERSION },
        payload: payload as object,
      }) as never,
  };
}

test('MCP 生命周期：initialize 协商版本 + 声明 tools 能力 + 返回 serverInfo', async () => {
  const s = setup();
  const app = Fastify();
  try {
    registerMcpServer(app, s.ctx, s.ctx.cfg);

    // 客户端请求受支持的版本 → 原样返回
    const same = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    });
    assert.equal(same.json().result.protocolVersion, '2025-03-26', '受支持版本应原样回显');
    assert.ok(same.json().result.capabilities.tools, '必须声明 tools 能力');
    assert.equal(same.json().result.serverInfo.name, 'socratic-tutor');
    assert.ok(same.headers['mcp-session-id']);

    // 客户端请求未知版本 → 回落到本服务最新支持版本
    const fallback = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    });
    assert.equal(fallback.json().result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);

    // 未声明版本 → 回落最新
    const noVersion = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} },
    });
    assert.equal(noVersion.json().result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);
  } finally {
    await app.close();
    cleanup(s);
  }
});

test('MCP 生命周期：ping / GET 405 / DELETE 终止会话 / 会话校验', async () => {
  const s = setup();
  const app = Fastify();
  try {
    registerMcpServer(app, s.ctx, s.ctx.cfg);
    const { sessionId, post } = await handshake(app);

    // ping
    const pong = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(pong.statusCode, 200);
    assert.deepEqual(pong.json().result, {});

    // GET → 405（本服务不提供 server→client SSE 流）
    const get = await app.inject({ method: 'GET', url: '/mcp' });
    assert.equal(get.statusCode, 405);

    // 伪造会话 → 404
    const forged = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': 'not-a-real-session' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    assert.equal(forged.statusCode, 404);

    // 不支持的协议版本头 → 400
    const badVersion = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '1999-01-01' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    assert.equal(badVersion.statusCode, 400);

    // DELETE 终止会话 → 之后该会话不可用
    const del = await app.inject({ method: 'DELETE', url: '/mcp', headers: { 'mcp-session-id': sessionId } });
    assert.equal(del.statusCode, 204);
    const after = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    });
    assert.equal(after.statusCode, 404, '已终止会话应返回 404');
  } finally {
    await app.close();
    cleanup(s);
  }
});

test('MCP 安全：非本地 Origin 被拒（防 DNS rebinding）', async () => {
  const s = setup();
  const app = Fastify();
  try {
    registerMcpServer(app, s.ctx, s.ctx.cfg);
    const evil = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'http://evil.example.com' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    assert.equal(evil.statusCode, 403);

    const local = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'http://localhost:3080' },
      payload: { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} },
    });
    assert.equal(local.statusCode, 200, '本地 Origin 应放行');
  } finally {
    await app.close();
    cleanup(s);
  }
});

// 回归 BUG-002：路由 handler 未 await/return async 的 handleJsonRpc，
// Fastify 序列化未决 Promise → 响应恒为 `{}`（函数级单测无法发现）。
test('回归 BUG-002：HTTP 层 tools/list 与 tools/call 返回真实 JSON-RPC 结果（非 {}）', async () => {
  const s = setup();
  const app = Fastify();
  try {
    registerMcpServer(app, s.ctx, s.ctx.cfg);
    const { post } = await handshake(app);

    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(list.statusCode, 200);
    const listBody = list.json();
    assert.deepEqual(Object.keys(listBody).sort(), ['id', 'jsonrpc', 'result'], '不得为空对象/错误结构');
    assert.equal(listBody.id, 1);
    assert.equal(listBody.result.tools.length, 7);
    assert.ok(list.body.length > 100, `响应体不应被序列化为 {}（实际 ${list.body.length} 字节）`);

    // tools/call 结果必须是规范的 { content, structuredContent }
    const call = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_learner_profile', arguments: {} },
    });
    assert.equal(call.statusCode, 200);
    const callBody = call.json();
    assert.equal(callBody.id, 2);
    assert.ok(Array.isArray(callBody.result.content), 'tools/call 必须返回 content 数组');
    assert.equal(callBody.result.content[0].type, 'text');
    assert.ok(callBody.result.content[0].text.length > 0, 'content 文本块不得为空');
    assert.equal(callBody.result.structuredContent.profile.learnerId, 'local-user');

    // 错误码也要经 HTTP 正确透出（而非被吞成 {}）
    const bad = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    assert.equal(bad.json().error.code, JsonRpcErrorCode.InvalidParams);
  } finally {
    await app.close();
    cleanup(s);
  }
});

test('callTool 直接分发与 JSON-RPC tools/call 一致', async () => {
  const s = setup();
  try {
    const r = await callTool('get_learner_profile', {}, s.ctx);
    assert.ok((r as { profile: object }).profile);
  } finally {
    cleanup(s);
  }
});