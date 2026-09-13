import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FrozenThread } from '../src/engines/eval/index.js';
import { sampleThreads, isFailureThread } from '../src/tracing/sample.js';
import { HashEmbeddingProvider } from '../src/providers/llm/embeddings.js';

const emb = new HashEmbeddingProvider(); // dim=8 确定性本地嵌入

function thread(id: string, topic: string, failure: boolean, text = id): FrozenThread {
  return {
    id,
    topic,
    turns: failure
      ? [{ role: 'user', content: text, signal: 'mistake' }]
      : [{ role: 'user', content: text, signal: 'correct' }],
  };
}

test('AC2 失败优先：mistake/confused 线程命中率高于随机基线', async () => {
  // 构造 20 条普通 + 5 条失败，目标抽取 10：失败加权后失败线程应被显著覆盖
  const threads: FrozenThread[] = [];
  for (let i = 0; i < 20; i++) threads.push(thread(`ok-${i}`, 'math', false));
  for (let i = 0; i < 5; i++) threads.push(thread(`fail-${i}`, 'math', true));
  const picked = await sampleThreads(threads, { size: 10, failureWeight: 3 });
  const failPicked = picked.filter((t) => isFailureThread(t)).length;
  // 期望命中：5 条失败 /25 条，加权 3 倍 → 池 15 失败 +20 普通 =35，取 10 应含约 4+ 失败
  assert.ok(failPicked >= 2, `失败优先应使失败线程被抽中较多，实际 ${failPicked}`);
});

test('AC2 分层：多 topic 都有代表', async () => {
  const threads = [
    thread('a1', 'math', false),
    thread('a2', 'math', false),
    thread('b1', 'physics', false),
    thread('b2', 'physics', false),
    thread('c1', 'python', false),
  ];
  const picked = await sampleThreads(threads, { size: 5, failureWeight: 2 });
  const topics = new Set(picked.map((t) => t.topic));
  assert.equal(picked.length, 5);
  assert.ok(topics.has('math') && topics.has('physics') && topics.has('python'), '各主题都有代表');
});

test('AC2 语义去重：embedding 下相似线程被去重，id 去重兜底', async () => {
  // 两条语义极近（同 __VEC 桶）只有 id 不同
  const threads = [
    thread('x1', 'math', false, '__VEC:2__ 矩阵特征值'),
    thread('x2', 'math', false, '__VEC:2__ 矩阵特征值'), // 语义同 x1
    thread('y1', 'math', false, '__VEC:5__ 诗歌意象'),
  ];
  const withSem = await sampleThreads(threads, { size: 3, failureWeight: 1, embedding: emb, dedupThreshold: 0.99 });
  // 语义去重后 x1/x2 只留一条
  assert.equal(withSem.filter((t) => /^x/.test(t.id)).length, 1, '语义相近线程应去重为一条');

  const withoutEmb = await sampleThreads(threads, { size: 3, failureWeight: 1 });
  assert.equal(withoutEmb.length, 3, '无 embedding 时按 id 去重，全部保留');
});