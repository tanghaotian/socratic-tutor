/** 对话中的一条消息（OpenAI 风格） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** LLM 调用选项 */
export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  /** 额外的模型提示，如覆盖默认 system prompt */
  systemPrompt?: string;
}

/** 结构化调用返回的泛型结果 */
export type StructuredResult<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  message: string;
};

/** 搜索结果条目 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 回答信号（signal_parser 输出） */
export type AnswerSignal = 'correct' | 'confused' | 'mistake' | 'divergent';