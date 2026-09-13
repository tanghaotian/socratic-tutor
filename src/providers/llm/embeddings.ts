import OpenAI from 'openai';

/**
 * 文本嵌入 Provider 接口（IT15 向量 RAG，详见 detail.md §10「向量 RAG」）。
 * 复用 OpenAI 兼容 /v1/embeddings 服务（豆包/DeepSeek/Qwen 等均可承载）。
 * 返回 null 表示该文本嵌入失败；调用方应据此降级（如跳过向量、退回关键词）。
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number; // 向量维度（在配置文件/构造时确定）
  /** 批量文本 → 向量；单个失败返回 null（整体不抛，便于降级）。 */
  embedMany(texts: string[]): Promise<Array<number[] | null>>;
}

/** OpenAI 兼容 embeddings 服务的连接配置 */
export interface OpenAICompatEmbeddingConfig {
  id: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * 通用的 OpenAI 兼容文本嵌入 Provider。
 * 适用于任意走 OpenAI /v1/embeddings 的服务。
 */
export class OpenAICompatEmbedding implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  private client: OpenAI;
  private model: string;

  constructor(cfg: OpenAICompatEmbeddingConfig, dim = 1536) {
    if (!cfg.apiKey) throw new Error(`[${cfg.id}] EMBEDDING 未配置 API_KEY`);
    if (!cfg.model) throw new Error(`[${cfg.id}] EMBEDDING 未配置 MODEL`);
    this.id = cfg.id;
    this.dim = dim;
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.model = cfg.model;
  }

  async embedMany(texts: string[]): Promise<Array<number[] | null>> {
    try {
      const resp = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });
      const data = resp.data;
      const vectors: (number[] | null)[] = [];
      for (const item of data) vectors.push(item.embedding ?? null);
      // 返回条数少于入参（服务端截断/过滤）时用 null 补齐，保持与入参长度一致
      while (vectors.length < texts.length) vectors.push(null);
      return vectors;
    } catch {
      // 嵌入失败不抛：全部置 null，交由调用方降级（跳过向量 / 退回关键词）
      return texts.map(() => null);
    }
  }
}

/**
 * 确定性本地嵌入（测试/离线演示用）：按文本中显式声明的语义桶返回基向量，
 * 或按文本特征做稳定哈希。不访问网络，便于单元测试向量检索排序。
 * 生产使用请以 OpenAICompatEmbedding（真实模型）为准。
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hash-local';
  readonly dim = 8;

  async embedMany(texts: string[]): Promise<Array<number[] | null>> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    // 语义桶显式标记：__VEC:n__ → 第 n 维为 1，便于测试构造可预期的语义近邻
    const m = /__VEC:(\d+)__/.exec(text);
    if (m) {
      const v = new Array(this.dim).fill(0);
      v[Number(m[1]) % this.dim] = 1;
      return v;
    }
    // 否则按字符分布做确定性哈希（同文本同向量；不同文本大概率不同）
    const v = new Array(this.dim).fill(0);
    for (const ch of text) {
      v[ch.codePointAt(0)! % this.dim] += 1;
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  }
}