import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  JsonRpcError,
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_INFO,
  isNotification,
  negotiateProtocolVersion,
  resolveProtocolVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallToolResult,
} from './types.js';
import { listTools, callTool, hasTool, MCP_TOOLS } from './tools.js';
import type { McpContext } from './context.js';
import type { AppConfig } from '../config.js';

/** 一次 MCP 会话的传输层状态（HTTP 层持有；进程内内存态，重启即失效） */
export interface McpSession {
  /** 协商后的协议版本 */
  protocolVersion: string;
  /** 是否已收到 notifications/initialized */
  initialized: boolean;
}

/**
 * 服务端能力声明。只声明 `tools`：本服务不提供 prompts / resources / logging。
 * `listChanged: false` —— 工具集运行期不变，不发 `notifications/tools/list_changed`。
 */
const SERVER_CAPABILITIES = { tools: { listChanged: false } } as const;

const SERVER_INSTRUCTIONS =
  '苏格拉底式对话教学服务。用 chat_socratic 发起一轮引导式对话（输入学员回答，返回教学动作与信号判定）；' +
  'get_learner_profile 读取学习画像；plan_generate/review_generate 生成学习计划与复盘；' +
  'summarize_resource 做资料结构化总结；trigger_reflection/confirm_upgrade 触发与确认每周反思升级。';

/**
 * 把工具返回的任意 JSON 结果包装成 MCP `tools/call` 标准结果。
 * 规范要求以 `content`（文本块）把结果呈现给模型，并鼓励结构化结果同时放入
 * `structuredContent`；此处两者并存：文本块供模型阅读，structuredContent 供客户端程序化消费。
 */
export function toCallToolResult(value: unknown): McpCallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result: McpCallToolResult = { content: [{ type: 'text', text }] };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

/**
 * 分发单个 JSON-RPC 报文。返回 `null` 表示这是**通知**（notification）：
 * 按 Streamable HTTP 规范应以 HTTP 202 空响应处理，不产生 JSON-RPC 响应。
 */
export async function handleJsonRpc(
  body: unknown,
  ctx: McpContext,
  session?: McpSession,
): Promise<JsonRpcResponse | null> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { jsonrpc: '2.0', id: null, error: { code: JsonRpcErrorCode.InvalidRequest, message: '非法请求：需为 JSON-RPC 2.0 对象' } };
  }
  const req = body as Partial<JsonRpcRequest>;
  const id = req.id === undefined ? null : req.id;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string' || req.method.length === 0) {
    return { jsonrpc: '2.0', id, error: { code: JsonRpcErrorCode.InvalidRequest, message: '非法请求：缺少 jsonrpc/method' } };
  }

  // ---- 通知：无 id 的报文不产生响应 ----
  if (isNotification(body)) {
    if (req.method === 'notifications/initialized' && session) session.initialized = true;
    // 其余通知（notifications/cancelled 等）本服务无副作用，静默接受
    return null;
  }

  try {
    // ---- 生命周期：initialize（MUST 为首个交互） ----
    if (req.method === 'initialize') {
      const params = (req.params ?? {}) as { protocolVersion?: unknown };
      const negotiated = negotiateProtocolVersion(params.protocolVersion);
      if (session) {
        session.protocolVersion = negotiated;
        session.initialized = false;
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: MCP_SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }

    // ---- 保活探测（规范 §Utilities/Ping） ----
    if (req.method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: listTools() };
    }

    if (req.method === 'tools/call') {
      const p = (req.params ?? {}) as Record<string, unknown>;
      const name = typeof p.name === 'string' && p.name ? p.name : '';
      if (!name) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, 'tools/call 缺少工具名 name');
      }
      if (!hasTool(name)) {
        // 规范 §Tools/Error Handling 示例：未知工具用 InvalidParams(-32602)
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `未知工具：${name}`);
      }
      const result = await callTool(name, p.arguments, ctx);
      return { jsonrpc: '2.0', id, result: toCallToolResult(result) };
    }

    throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `未支持的方法：${req.method}`);
  } catch (e) {
    if (e instanceof JsonRpcError) {
      return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
    }
    return { jsonrpc: '2.0', id, error: { code: JsonRpcErrorCode.InternalError, message: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * 校验 Origin 头，防 DNS rebinding（规范 §Security Warning：服务端 MUST 校验）。
 * 仅允许本地来源；无 Origin 的非浏览器客户端（curl、MCP 客户端库）放行。
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * IT17：MCP Server（Streamable HTTP transport）。
 *
 * 在既有 Fastify 上挂载 `/mcp` 单端点，支持 POST（JSON-RPC）与 DELETE（终止会话），
 * GET 返回 405（本服务不提供 server→client 的 SSE 流）。
 * 已实现规范要求的最小完整生命周期：initialize 握手 + 版本协商 + Mcp-Session-Id 会话 +
 * notifications/initialized + ping + tools/list + tools/call（标准 content 结果）。
 *
 * 会话为进程内内存态（重启失效）；`initialize` 之外的请求必须携带有效 `Mcp-Session-Id`，
 * 否则 400。`MCP_ENABLED=false` 时不注册任何路由。
 */
export function registerMcpServer(app: FastifyInstance, ctx: McpContext, cfg: AppConfig): void {
  if (!cfg.mcp.enabled) return;

  /** 活跃会话：sessionId → 状态 */
  const sessions = new Map<string, McpSession>();

  /** 逐请求的传输层前置校验；返回 undefined 表示放行 */
  const rejectTransport = (
    request: FastifyRequest,
    requireSession: boolean,
  ): { status: number; message: string } | undefined => {
    if (!isOriginAllowed(request.headers.origin as string | undefined)) {
      return { status: 403, message: 'Origin 不被允许（防 DNS rebinding）' };
    }
    const versionRaw = request.headers['mcp-protocol-version'] as string | undefined;
    const version = resolveProtocolVersion(versionRaw);
    if (version === undefined) {
      return {
        status: 400,
        message: `不支持的 MCP-Protocol-Version：${versionRaw}（支持：${MCP_PROTOCOL_VERSIONS.join(', ')}）`,
      };
    }
    if (requireSession) {
      const sid = request.headers['mcp-session-id'] as string | undefined;
      if (!sid) return { status: 400, message: '缺少 Mcp-Session-Id（请先 initialize）' };
      if (!sessions.has(sid)) return { status: 404, message: '会话不存在或已终止（请重新 initialize）' };
    }
    return undefined;
  };

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    // initialize 是唯一不要求携带会话 ID 的请求
    const isInitialize =
      request.body !== null &&
      typeof request.body === 'object' &&
      (request.body as { method?: unknown }).method === 'initialize';

    const rejection = rejectTransport(request, !isInitialize);
    if (rejection) return reply.code(rejection.status).send({ error: rejection.message });

    let session: McpSession | undefined;
    if (isInitialize) {
      // 新建会话：建立后在响应头返回 Mcp-Session-Id
      session = { protocolVersion: '', initialized: false };
    } else {
      const sid = request.headers['mcp-session-id'] as string;
      session = sessions.get(sid);
      if (!session) return reply.code(404).send({ error: '会话不存在或已终止（请重新 initialize）' });
    }

    const res = await handleJsonRpc(request.body, ctx, session);

    if (isInitialize && session) {
      const sid = randomUUID(); // 全局唯一、密码学安全、仅可见 ASCII
      sessions.set(sid, session);
      reply.header('Mcp-Session-Id', sid);
    }

    // 通知：规范要求 202 且无响应体
    if (res === null) return reply.code(202).send();

    return reply.code(200).send(res);
  });

  // 本服务不提供 server→client 的独立 SSE 流（规范允许返回 405）
  app.get('/mcp', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).send({ error: '本服务不提供 GET 事件流，请使用 POST' }),
  );

  // 客户端可显式终止会话（规范 §Session Management）
  app.delete('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const sid = request.headers['mcp-session-id'] as string | undefined;
    if (sid) sessions.delete(sid);
    return reply.code(204).send();
  });

  console.log(
    `[mcp] MCP Server 已挂载: /mcp（Streamable HTTP，${MCP_TOOL_COUNT} 个 tools，` +
      `协议版本 ${MCP_PROTOCOL_VERSIONS.join('/')}）`,
  );
}

const MCP_TOOL_COUNT = MCP_TOOLS.length;
