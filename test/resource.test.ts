import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';
import { ResourceEngine } from '../src/engines/resource.js';
import { MockSearchProvider } from '../src/providers/search/mock.js';

class StubLLM implements LLMProvider {
  readonly id = 'stub';
  async chat(_m: ChatMessage[], _o?: LLMOptions): Promise<string> {
    return 'ok';
  }
  async *streamChat(_m: ChatMessage[], _o?: LLMOptions): AsyncIterable<string> {
    yield 'ok';
  }
  async structuredCall<T>(_s: string, _u: string, _schema: object): Promise<StructuredResult<T>> {
    return {
      ok: true,
      data: {
        key_points: ['用提问引导反思'],
        teaching_implications: ['confused 时应给更小台阶的提示'],
        followups: ['如何量化认知冲突深度'],
      } as T,
    };
  }
}

function setup(): { dir: string; engine: ResourceEngine } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-res-'));
  const knowledge = path.join(dir, 'knowledge');
  fs.mkdirSync(knowledge, { recursive: true });
  const engine = new ResourceEngine(new StubLLM(), new MockSearchProvider(), knowledge);
  return { dir, engine };
}

test('bookToSkill 生成 knowledge/skills/<slug>.md 并刷新 RAG', async () => {
  const { dir, engine } = setup();
  try {
    const result = await engine.bookToSkill('book', '某教学法书籍内容……提问驱动', 'The Teaching Book');
    assert.ok(fs.existsSync(result.file));
    assert.ok(result.file.endsWith('.md'));
    assert.ok(result.keyPoints.length > 0);
    const content = fs.readFileSync(result.file, 'utf-8');
    assert.match(content, /^# The Teaching Book/m);
    assert.match(content, /## 教学与自适应启示/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryRag 可按关键词命中已入库 skill', async () => {
  const { dir, engine } = setup();
  try {
    await engine.bookToSkill('book', '这本书教你用提问驱动学习。', 'Causality');
    // 检索的是 skill 摘要（LLM 产出），query 命中摘要关键词即可
    const hits = engine.queryRag('提问');
    assert.ok(hits.length >= 1);
    assert.match(hits[0].title, /Causality/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchWeb 走 SearchProvider 返回结果', async () => {
  const { dir, engine } = setup();
  try {
    const results = await engine.searchWeb('苏格拉底');
    assert.ok(results.length >= 1);
    assert.ok('title' in results[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('无命中时 queryRag 返回空', () => {
  const { dir, engine } = setup();
  try {
    const hits = engine.queryRag('不存在的词汇xyzabc');
    assert.equal(hits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});