import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectorStore } from '../src/storage/vec.js';
import { RAGStore } from '../src/storage/rag.js';
import { HashEmbeddingProvider } from '../src/providers/llm/embeddings.js';

/** 构造临时 knowledge 目录并写入若干 md 知识源 */
function setup(tmp: string, files: Record<string, string>): string {
  const knowledge = path.join(tmp, 'knowledge');
  fs.mkdirSync(knowledge, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(knowledge, name), content, 'utf-8');
  }
  return knowledge;
}

// ---- AC-1：sqlite-vec 在 node:sqlite 加载并建表/检索 ----
test('AC-1 VectorStore: 加载 sqlite-vec 扩展并完成向量建表与 KNN 检索', () => {
  const vs = new VectorStore();
  assert.equal(vs.load(), true, 'sqlite-vec 扩展应能加载');
  assert.equal(vs.isLoaded, true);

  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const c = [1, 0.05, 0]; // 与 a 更近
  const idA = vs.upsert(a);
  const idB = vs.upsert(b);
  const idC = vs.upsert(c);
  assert.ok(idA != null && idB != null && idC != null);

  const hits = vs.search([1, 0, 0], 3);
  assert.equal(hits.length, 3);
  // 距离升序：最近的第一条是 a 或 c（都与 [1,0,0] 近）
  assert.ok(hits[0].distance <= hits[1].distance && hits[1].distance <= hits[2].distance);
  vs.close();
});

test('AC-1 VectorStore: clear 后检索为空', () => {
  const vs = new VectorStore();
  vs.load();
  vs.upsert([1, 0, 0]);
  assert.equal(vs.clear(), true);
  assert.equal(vs.search([1, 0, 0]).length, 0);
  vs.close();
});

// ---- AC-2：有 embedding 时语义相关（无共同关键词）也能命中 ----
test('AC-2 RAG hybrid: 语义相关但无关键词交集的查询能命中对应知识', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-vec-'));
  try {
    const knowledge = setup(tmp, {
      'math.md': '# 线性代数\n\n语义桶 __VEC:1__ 描述了矩阵特征值相关内容，用于向量空间变换。',
      'literature.md': '# 文学史\n\n语义桶 __VEC:3__ 记录了莎士比亚戏剧的意象与主题，用于文本赏析。',
    });
    const emb = new HashEmbeddingProvider(); // dim=8，__VEC:n__ 映射到第 n 维
    const rag = new RAGStore(knowledge, { embedding: emb, backend: 'hybrid' });
    await rag.ensureVectors();
    // 查询向量语义上靠近 "math"（__VEC:1__），但查询文本不含 math 关键词
    const hits = await rag.searchHybrid('__VEC:1__ 特征向量', 3);
    assert.ok(hits.length >= 1, 'hybrid 应至少命中一条（向量召回）');
    assert.match(hits[0].file, /math\.md/, '语义最近的知识应是 math.md（向量近邻）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- AC-3：无 embedding / keyword 后端时走纯关键词，行为与 IT7 一致 ----
test('AC-3 RAG keyword: 无 embedding 时 queryRagHybrid 等同纯关键词', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-vec-'));
  try {
    const knowledge = setup(tmp, { 'causality.md': '# 因果推断\n\n这本书教你用提问驱动学习。' });
    const rag = new RAGStore(knowledge); // 默认 keyword，无 embedding
    // 关键词命中
    const hits = await rag.searchHybrid('提问', 3);
    assert.ok(hits.length >= 1);
    assert.match(hits[0].title, /因果推断/);
    // 语义无关查询（关键词不命中）→ 空（不发散到向量）
    const miss = await rag.searchHybrid('不存在的词xyz', 3);
    assert.equal(miss.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-3 RAG keyword: 注入 embedding 但 backend=keyword 仍走纯关键词', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-vec-'));
  try {
    const knowledge = setup(tmp, { 'a.md': '# A\n\n含有明确关键词的内容' });
    const rag = new RAGStore(knowledge, { embedding: new HashEmbeddingProvider(), backend: 'keyword' });
    await rag.ensureVectors();
    const hits = await rag.searchHybrid('明确关键词', 3);
    assert.ok(hits.length >= 1, 'keyword 后端用关键词命中');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- AC-4：reload 后向量索引同步刷新（新增 skill 后能语义命中） ----
test('AC-4 reload 后向量索引同步，新增知识可被语义检索命中', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-vec-'));
  try {
    const knowledge = setup(tmp, { 'origin.md': '# 原始\n\n语义桶 __VEC:1__ 旧知识' });
    const emb = new HashEmbeddingProvider();
    const rag = new RAGStore(knowledge, { embedding: emb, backend: 'hybrid' });
    await rag.ensureVectors();
    // 新增文件
    fs.writeFileSync(path.join(knowledge, 'new.md'), '# 新增\n\n语义桶 __VEC:2__ 的新知识', 'utf-8');
    rag.reload(); // 触发向量重建
    await rag.ensureVectors();
    const hits = await rag.searchHybrid('__VEC:2__ 新话题', 3);
    assert.ok(hits.some((h) => /new\.md/.test(h.file)), 'reload 后新增知识可由语义命中');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});