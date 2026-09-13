import type { FrozenThread } from '../engines/eval/index.js';
import type { EmbeddingProvider } from '../providers/llm/embeddings.js';

/**
 * 分层抽样 + 失败优先 + 语义去重（IT16，详见 detail.md §10）。
 * 从全部录制线程（FrozenThread[]）中抽取"典型问题"子集，用于构建黄金数据集 / 评测采样。
 *
 * 策略：
 * - **失败优先（failure-first）**：含 mistake/confused 信号的线程被优先选中，
 *   失败预算 = `ceil(size * failureWeight / (failureWeight+1))`（默认取约 size 的 3/4）。
 * - **分层（layered）**：先保证每个主题至少 1 条代表，再用失败预算填充。
 * - **语义去重（semantic dedup）**：接入 EmbeddingProvider 时按余弦相似度去重；未接入按 id 去重。
 */
export interface SamplerOptions {
  /** 目标样本量 */
  size: number;
  /** fail-first 倍率（>=1）：失败线程在结果中的占比权重（约 failureWeight/(failureWeight+1)） */
  failureWeight: number;
  /** 语义去重：可选 embedding；为 null 时退化为 id 去重 */
  embedding?: EmbeddingProvider | null;
  /** 语义去重相似度阈值（cosine，越高越严格）。默认 0.95 */
  dedupThreshold?: number;
}

/** 判断线程是否为"失败型"（含 mistake/confused 信号） */
export function isFailureThread(t: FrozenThread): boolean {
  return t.turns.some((x) => x.signal === 'mistake' || x.signal === 'confused');
}

/** 线程代表文本（用于语义去重）：取首条 user 内容 */
function threadRepr(t: FrozenThread): string {
  const first = t.turns.find((x) => x.role === 'user');
  return first?.content ?? t.id;
}

/** 确定性伪随机：基于字符串稳定哈希取 [0, mod) */
function hashMod(id: string, mod: number): number {
  if (mod <= 1) return 0;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % mod;
}

/** 确定性打乱（基于 id 哈希），保证可复现 */
function shuf<T extends { id: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => hashMod(a.id, 1 << 20) - hashMod(b.id, 1 << 20));
}

/**
 * 采样主流程（确定性、可复现）：
 * 1. 按 topic 分层，每主题保底 1 条（不足则全部）；
 * 2. 用失败预算从失败线程补齐；
 * 3. 用剩余额度从普通线程补齐；
 * 4. 语义/id 去重。
 */
export async function sampleThreads(
  threads: FrozenThread[],
  opts: SamplerOptions,
): Promise<FrozenThread[]> {
  if (threads.length === 0) return [];
  const size = Math.min(opts.size, threads.length);
  const weight = Math.max(1, opts.failureWeight);
  const failBudget = Math.min(
    threads.filter((t) => isFailureThread(t)).length,
    Math.ceil((size * weight) / (weight + 1)),
  );

  // 分层：按 topic 分桶
  const byTopic = new Map<string, FrozenThread[]>();
  for (const t of threads) {
    if (!byTopic.has(t.topic ?? 'general')) byTopic.set(t.topic ?? 'general', []);
    byTopic.get(t.topic ?? 'general')!.push(t);
  }
  const topics = [...byTopic.keys()].sort();
  // 每主题保底 1 条（确定性）
  const selected: FrozenThread[] = [];
  const used = new Set<string>();
  for (const k of topics) {
    const [lead] = shuf(byTopic.get(k)!);
    if (lead && !used.has(lead.id)) {
      selected.push(lead);
      used.add(lead.id);
    }
  }

  const fills = (list: FrozenThread[], budget: number): void => {
    for (const t of shuf(list)) {
      if (selected.length >= size) break;
      if (!used.has(t.id)) {
        selected.push(t);
        used.add(t.id);
      }
    }
  };

  // 失败预算：优先用失败线程填
  const fails = threads.filter((t) => isFailureThread(t));
  fills(fails, failBudget);
  // 若失败预算未用满（失败不足），用普通线程补足
  const others = threads.filter((t) => !isFailureThread(t));
  fills(others, size - selected.length);

  // 语义/id 去重
  return opts.embedding
    ? dedupSemantic(selected, opts.embedding, opts.dedupThreshold ?? 0.95)
    : dedupById(selected);
}

/** id 去重：保留首个出现的线程 */
function dedupById(selected: FrozenThread[]): FrozenThread[] {
  const seen = new Set<string>();
  const out: FrozenThread[] = [];
  for (const t of selected) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** 语义去重：与已选集两两比较余弦相似度，超过阈值则跳过 */
async function dedupSemantic(
  selected: FrozenThread[],
  emb: EmbeddingProvider,
  threshold: number,
): Promise<FrozenThread[]> {
  const out: FrozenThread[] = [];
  for (const t of selected) {
    let first = true;
    for (const prev of out) {
      const sim = await cosine(threadRepr(prev), threadRepr(t), emb);
      if (sim != null && sim >= threshold) {
        first = false;
        break;
      }
    }
    if (first) out.push(t);
  }
  return out;
}

/** 两个线程代表文本的余弦相似度；embedding 异常/维度不符返回 null */
async function cosine(a: string, b: string, emb: EmbeddingProvider): Promise<number | null> {
  const vecs = await emb.embedMany([a, b]);
  if (!vecs[0] || !vecs[1]) return null;
  const [va, vb] = [vecs[0], vecs[1]];
  if (va.length !== vb.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return null;
  return dot / denom;
}