import type { ChatMessage, LLMOptions, SearchResult, StructuredResult } from './types.js';

/** LLM（对话/流式/结构化）Provider 接口 */
export interface LLMProvider {
  readonly id: string;
  /** 普通对话，返回一条 assistant 消息 */
  chat(messages: ChatMessage[], opts?: LLMOptions): Promise<string>;
  /** 流式对话 */
  streamChat(messages: ChatMessage[], opts?: LLMOptions): AsyncIterable<string>;
  /** 结构化输出调用：要求模型按给定 JSON 结构返回 */
  structuredCall<T>(system: string, user: string, schema: object): Promise<StructuredResult<T>>;
}

/**
 * ASR Provider 接口。
 * Phase 1 为非实时：整段音频转文本。Phase 2 预留流式识别。
 */
export interface ASRProvider {
  readonly id: string;
  /** 整段音频 Buffer → 文本 */
  transcribe(audio: Buffer): Promise<string>;
}

/** TTS Provider 接口（非实时，返回合成音频 Buffer） */
export interface TTSProvider {
  readonly id: string;
  synthesize(text: string): Promise<Buffer>;
}

/** 反思/升级提醒类 Provider（可扩展 web/email/wechat） */
export interface ReminderProvider {
  readonly id: 'web' | 'email' | 'wechat';
  notify(title: string, content: string, target?: string): Promise<void>;
}

/** 联网检索 Provider 接口 */
export interface SearchProvider {
  readonly id: string;
  search(query: string): Promise<SearchResult[]>;
}