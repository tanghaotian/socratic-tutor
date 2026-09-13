import OpenAI from 'openai';
import type { ChatMessage, LLMOptions, StructuredResult } from '../types.js';
import type { LLMProvider } from '../interfaces.js';

/** OpenAI 兼容 /v1/chat/completions 服务的连接配置（泛化 provider，如 qwen/百炼） */
export interface OpenAICompatConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * 通用 OpenAI 兼容 LLM Provider。
 * 适用于任意走 OpenAI /v1/chat/completions 的服务（阿里云百炼 qwen、国产厂商等），
 * 以及 judge 独立强模型的覆盖实例。与 doubao/deepseek 实现同构。
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  private client: OpenAI;
  private model: string;

  constructor(id: string, cfg: OpenAICompatConfig) {
    if (!cfg.apiKey) throw new Error(`[${id}] API_KEY 未配置`);
    if (!cfg.model) throw new Error(`[${id}] MODEL 未配置`);
    this.id = id;
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.model = cfg.model;
  }

  async chat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    });
    return resp.choices[0]?.message?.content ?? '';
  }

  async *streamChat(messages: ChatMessage[], opts: LLMOptions = {}): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async structuredCall<T>(
    system: string,
    user: string,
    schema: object,
  ): Promise<StructuredResult<T>> {
    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      const raw = resp.choices[0]?.message?.content ?? '';
      return { ok: true, data: JSON.parse(raw) as T };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}