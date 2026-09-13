/**
 * MCP Server 的 JSON-RPC 2.0 结构定义（IT17）。
 * 遵循 design §11：进程外/HTTP JSON-RPC，Node 侧统一封装。
 */

/**
 * MCP 协议版本（生命周期协商，见 MCP spec 2025-06-18 §Lifecycle）。
 * 本服务按倒序声明**支持的版本**；客户端请求哪一版就回哪一版（版本协商），
 * 请求了不支持的版本则回落到最新支持版本，由客户端自行决定是否断开。
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** 最新支持的协议版本（协商回落目标） */
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

/**
 * Streamable HTTP 规范：客户端未带 `MCP-Protocol-Version` 头且服务端无从判断时，
 * 应假定为 `2025-03-26`（向后兼容要求）。
 */
export const MCP_DEFAULT_PROTOCOL_VERSION = '2025-03-26';

/** 解析并校验客户端声明的协议版本；缺失时返回规范要求的默认值，非法/不支持返回 undefined */
export function resolveProtocolVersion(raw: string | undefined): string | undefined {
  if (!raw) return MCP_DEFAULT_PROTOCOL_VERSION;
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(raw) ? raw : undefined;
}

/** 版本协商：客户端请求的版本若受支持则原样返回，否则回落到本服务最新支持版本 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL_VERSION;
}

/** MCP 服务端实现信息（initialize 响应中的 serverInfo） */
export const MCP_SERVER_INFO = {
  name: 'socratic-tutor',
  title: 'Socratic Tutor MCP Server',
  version: '0.7.0',
} as const;

/** JSON-RPC 标准错误码 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** 业务自定义：MCP 工具内部异常（如缺少必需参数、存储/Provider 异常） */
  ServerError: -32000,
} as const;

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

/** 携带命名共错误信息的运行时错误，可由工具/分发层抛出 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** 成功响应 */
export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

/** 错误响应 */
export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** MCP tools/call 的入参约定的 arguments 是对象 */
export function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, 'params.arguments 必须是对象');
}

/** 从工具入参读取必需字符串字段 */
export function requiredString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `缺少必需参数：${key}`);
  }
  return v;
}

/**
 * 判断一个 JSON-RPC 报文是否为**通知**（notification）：
 * 有 `method` 且**没有** `id`。规范要求 Streamable HTTP 收到通知时返回 202 且无响应体。
 */
export function isNotification(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const req = body as { method?: unknown; id?: unknown };
  return typeof req.method === 'string' && req.id === undefined;
}

/** MCP 工具结果中的文本内容块 */
export interface McpTextContent {
  type: 'text';
  text: string;
}

/**
 * MCP `tools/call` 的标准结果结构（spec §Tools/Tool Result）。
 * - `content` 必填，用于把结果呈现给模型；
 * - `structuredContent` 可选，携带机器可读的结构化结果（本服务一并提供，二者并存）；
 * - `isError` 标记**工具执行失败**（区别于 JSON-RPC 协议级错误）。
 */
export interface McpCallToolResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}