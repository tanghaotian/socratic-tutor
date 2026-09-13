import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SocraticEngine, type AdaptiveProfile, type SocraticContext } from '../src/engines/socratic.js';
import type { LLMProvider, ChatMessage, LLMOptions, StructuredResult } from '../src/providers/index.js';

/** 桩 LLM：chat 返回占位文案，structuredCall 可配置信号 */
class StubLLM implements LLMProvider {
  readonly id = 'stub';
  signal: 'correct' | 'confused' | 'mistake' | 'divergent' = 'correct';
  chatCalls = 0;

  async chat(_msgs: ChatMessage[], _opts?: LLMOptions): Promise<string> {
    this.chatCalls++;
    return '（测试生成的引导语）';
  }
  async *streamChat(_msgs: ChatMessage[], _opts?: LLMOptions): AsyncIterable<string> {
    yield '引导';
  }
  async structuredCall<T>(system: string, _user: string, _schema: object): Promise<StructuredResult<T>> {
    return {
      ok: true,
      data: { signal: this.signal, confidence: 0.9, concept_ids: [], error_categories: [] } as T,
    };
  }
}

/** 画像桩 */
function profile(): AdaptiveProfile {
  return { adjustDepth: () => 1, mastery: () => 0.5 };
}

async function run(llm: StubLLM, ctx: Partial<SocraticContext> = {}) {
  const engine = new SocraticEngine(llm);
  return engine.generateAction({ answer: '测试回答', concept: '微积分', profile: profile(), ...ctx });
}

test('correct 信号 → 触发 conflict 追问', async () => {
  const llm = new StubLLM();
  llm.signal = 'correct';
  const a = await run(llm);
  assert.equal(a.type, 'ask');
  if (a.type === 'ask') assert.equal(a.strategy, 'conflict');
});

test('连续 correct 两次 → 触发自我评估', async () => {
  const llm = new StubLLM();
  llm.signal = 'correct';
  const a = await run(llm, { history: ['correct'] });
  assert.equal(a.type, 'assess_self');
});

test('confused 连续两次 → 触发 hint（不给答案）', async () => {
  const llm = new StubLLM();
  llm.signal = 'confused';
  const a = await run(llm, { history: ['confused'] });
  assert.equal(a.type, 'hint');
});

test('confused 首次 → focus 聚焦追问', async () => {
  const llm = new StubLLM();
  llm.signal = 'confused';
  const a = await run(llm, { history: ['correct'] });
  assert.equal(a.type, 'ask');
  if (a.type === 'ask') assert.equal(a.strategy, 'focus');
});

test('mistake 信号 → evaluate（指出需再看一眼）', async () => {
  const llm = new StubLLM();
  llm.signal = 'mistake';
  const a = await run(llm);
  assert.equal(a.type, 'evaluate');
});

test('divergent 信号 → open 开放式提问', async () => {
  const llm = new StubLLM();
  llm.signal = 'divergent';
  const a = await run(llm);
  assert.equal(a.type, 'ask');
  if (a.type === 'ask') assert.equal(a.strategy, 'open');
});

test('可注入外部 signal，跳过内部解析', async () => {
  const llm = new StubLLM();
  const engine = new SocraticEngine(llm);
  const a = await engine.generateAction({
    answer: '注入',
    signal: { signal: 'correct', confidence: 1, conceptIds: [], errorCategories: [] },
  });
  assert.equal(a.type, 'ask');
  assert.equal(llm.chatCalls, 1); // 仅文案生成，不再调 structuredCall
});