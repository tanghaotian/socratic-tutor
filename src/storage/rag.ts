import fs from 'node:fs';
import path from 'node:path';
import { VectorStore, type VecHit } from './vec.js';
import type { EmbeddingProvider } from '../providers/llm/embeddings.js';

/** RAG 检索后端策略 */
export type RagBackend = 'keyword' | 'hybrid';

/**
 * 轻量 md RAG（IT7 关键词；IT15 可选向量/混合）。
 * - 关键词：读取 knowledge/skills/ 下所有 md → 关键词/全文分块打分 → 返回 Top-K。
 * - 向量/混合（IT15）：可注入 EmbeddingProvider，`searchHybrid` 先做语义向量检索后再与关键词结果合并/择优；
 *   未注入 embedding（或注入失败）自动降级为纯关键词，保证全链路可用、不侵入既有调用方。
 */
export interface RagHit {
  file: string; // 相对路径，如 skill/foo.md
  title: string;
  chunk: string;
  score: number;
}

export interface RAGStoreOptions {
  embedding?: EmbeddingProvider;
  /** 检索后端：keyword（默认，降级兜底）| hybrid（注入 embedding 后启用语义检索） */
  backend?: RagBackend;
}

/**
 * 归一化打分（向量距离 → 0~贴近 1 的相似分）。distance 为 L2，越小越相似。
 */
function scoreFromDistance(distance: number): number {
  // 经验映射：距离 0 → 1.0，距离越大分数越低；clamp 到 [0, 1]
  return Math.max(0, Math.min(1, 1 - distance / 10));
}

export class RAGStore {
  private files: { rel: string; abs: string; title: string; content: string }[] = [];
  private embedding?: EmbeddingProvider;
  private backend: RagBackend;
  private vec: VectorStore;
  /** vec 自增 id → 该 chunk 的元信息（向量命中后反查原文） */
  private vecMeta = new Map<number, { file: string; title: string; chunk: string }>();
  private vectorBuild?: Promise<void>;

  constructor(private knowledgeDir: string, opts: RAGStoreOptions = {}) {
    this.embedding = opts.embedding;
    this.backend = opts.backend ?? 'keyword';
    this.vec = new VectorStore();
    this.vec.load();
    this.reload();
  }

  /** 重新扫描知识目录（新增 skill 后调用）；同步重建关键词索引，异步重建向量索引（有 embedding 时）。 */
  reload(): void {
    this.files = [];
    this.vecMeta.clear();
    this.vec.clear();
    if (!fs.existsSync(this.knowledgeDir)) return;
    for (const entry of fs.readdirSync(this.knowledgeDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const abs = path.join(this.knowledgeDir, entry.name);
        const content = fs.readFileSync(abs, 'utf-8');
        this.files.push({
          rel: entry.name,
          abs,
          title: firstHeading(entry.name, content),
          content,
        });
      }
    }
    // 有 embedding 且启用 hybrid 时，异步嵌入并写入向量表
    if (this.embedding && this.vec.isLoaded && this.backend === 'hybrid') {
      this.vectorBuild = this.buildVectorIndex();
    }
  }

  /** 后台重建向量索引：每个文件分块 → 批量嵌入 → upsert，并记录 id→元信息。失败静默降级（保留关键词）。 */
  private async buildVectorIndex(): Promise<void> {
    if (!this.embedding || !this.vec.isLoaded) return;
    const jobs: { chunk: string; title: string; rel: string }[] = [];
    for (const f of this.files) {
      for (const c of splitChunks(f.content, f.title)) {
        jobs.push({ chunk: c, title: f.title, rel: f.rel });
      }
    }
    if (jobs.length === 0) return;
    // 为可控性，整体 try 包裹：任一块嵌入失败则全部忽略（避免把 null 写入）
    const vectors = await this.embedding.embedMany(jobs.map((j) => j.chunk));
    if (vectors.some((v) => v == null)) return;
    for (let i = 0; i < jobs.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      const id = this.vec.upsert(v);
      if (id != null) {
        this.vecMeta.set(id, { file: jobs[i].rel, title: jobs[i].title, chunk: jobs[i].chunk });
      }
    }
  }

  /**
   * 确保向量索引已就绪（等待后台构建完成）。未启用 hybrid / 无 embedding 时直接返回。
   */
  async ensureVectors(): Promise<void> {
    if (this.backend !== 'hybrid' || !this.embedding || !this.vec.isLoaded) return;
    if (!this.vectorBuild) {
      this.vectorBuild = this.buildVectorIndex();
    }
    await this.vectorBuild;
  }

  /**
   * 混合/语义检索（IT15）：有 embedding 时先做向量 KNN，再与关键词命中择优/加权；
   * 未启用 hybrid 或无 embedding 时退回纯关键词（与 IT7 行为一致）。
   */
  async searchHybrid(query: string, topK = 3): Promise<RagHit[]> {
    const keywordHits = this.search(query, topK);
    if (this.backend !== 'hybrid' || !this.embedding || !this.vec.isLoaded) {
      return keywordHits;
    }
    await this.ensureVectors();
    const qVec = (await this.embedding.embedMany([query]))[0];
    if (!qVec) return keywordHits;
    const vecHits: VecHit[] = this.vec.search(qVec, topK);
    if (vecHits.length === 0) return keywordHits;

    // 向量命中 → 组装 RagHit；并尝试关键词加分（同 file 命中则取更高分数）
    const combined = new Map<string, RagHit>();
    for (const vh of vecHits) {
      const meta = this.vecMeta.get(vh.id);
      if (!meta) continue;
      let score = scoreFromDistance(vh.distance);
      const kw = keywordHits.find((k) => k.file === meta.file);
      if (kw) score = Math.max(score, kw.score);
      combined.set(meta.file, { file: meta.file, title: meta.title, chunk: meta.chunk, score });
    }
    // 未被向量召回但关键词命中的，兜底加入（保证关键词召回不丢失）
    for (const kh of keywordHits) {
      if (!combined.has(kh.file)) combined.set(kh.file, kh);
    }
    return [...combined.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 关键词检索：对每个文件计算关键词命中评分，返回 Top-K 文件与命中片段。
   */
  search(query: string, topK = 3): RagHit[] {
    if (this.files.length === 0) return [];
    const terms = tokenize(query);

    const hits: RagHit[] = [];
    for (const f of this.files) {
      let score = 0;
      let bestChunk = '';
      let bestScore = 0;
      const chunks = splitChunks(f.content, f.title);
      for (const c of chunks) {
        let cs = 0;
        for (const t of terms) {
          if (c.includes(t)) cs += 1;
        }
        if (cs > bestScore) {
          bestScore = cs;
          bestChunk = c;
        }
      }
      // 标题命中加分
      for (const t of terms) {
        if (f.title.includes(t)) score += 2;
      }
      score += bestScore;
      if (bestScore > 0) {
        hits.push({ file: f.rel, title: f.title, chunk: bestChunk, score });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

/** 取首个标题行作为文档标题 */
function firstHeading(fileName: string, content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fileName.replace(/\.md$/, '');
}

/** 简单分词：中文按字符集粗分，英文按空格 */
function tokenize(query: string): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  // 中文字符逐字；连续英文/数字按词
  const tokens: string[] = [];
  let latin = '';
  for (const ch of q) {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      if (latin) { tokens.push(latin); latin = ''; }
      tokens.push(ch);
    } else if (/[a-z0-9]/.test(ch)) {
      latin += ch;
    } else {
      if (latin) { tokens.push(latin); latin = ''; }
    }
  }
  if (latin) tokens.push(latin);
  // 去除单字高频噪声
  return tokens.filter((t) => t.length > 0);
}

/** 把文档切成 300 字左右的块（按换行聚合） */
function splitChunks(content: string, title: string): string[] {
  const body = content.replace(/^#.*$/m, '').trim();
  const lines = body.split('\n');
  const chunks: string[] = [];
  let buf = '';
  let acc = 0;
  const MAX = 300;
  for (const line of lines) {
    if (acc + line.length > MAX && buf) {
      chunks.push(buf.trim());
      buf = '';
      acc = 0;
    }
    buf += `${line}\n`;
    acc += line.length + 1;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [content];
}