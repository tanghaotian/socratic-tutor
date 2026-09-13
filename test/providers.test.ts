import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, LLMModel } from '../src/config.js';
import { LLMRegistry, OpenAICompatProvider } from '../src/providers/index.js';

type LLMCfg = AppConfig['llm'];

/** 构造一份用于测试的 llm 配置（注入假 key 以通过构造阶段） */
function makeLLMCfg(over?: Partial<LLMCfg>): LLMCfg {
  const models: LLMModel[] = [
    { id: 'qwen', apiKey: 'sk-test', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash' },
  ];
  return {
    provider: 'qwen',
    judge: { provider: '', model: '' },
    models,
    ...over,
  };
}

test('LLMRegistry：从 models 清单自动注册（懒加载，无需 key）', () => {
  const r = new LLMRegistry(makeLLMCfg());
  assert.deepEqual(r.list(), ['qwen']);
});

test('LLMRegistry：LLM_EXTRA_MODELS 追加的模型零代码注册', () => {
  // 模拟 config 已把额外模型并入 models 数组
  const r = new LLMRegistry(
    makeLLMCfg({
      models: [
        ...makeLLMCfg().models,
        { id: 'glm', apiKey: 'sk-glm', baseURL: 'https://example.com/v1', model: 'glm-x' },
      ],
    }),
  );
  assert.ok(r.list().includes('glm'), '额外模型应自动进入注册表');
  const glm = r.getById('glm');
  assert.ok(glm instanceof OpenAICompatProvider);
  assert.equal(glm.id, 'glm');
});

test('parseExtraModels-like：坏配置（缺真实 key 的模型）可注册但访问才抛错', () => {
  const r = new LLMRegistry(
    makeLLMCfg({
      provider: 'nomodel',
      models: [{ id: 'nomodel', apiKey: '', baseURL: 'x', model: '' }],
    }),
  );
  // 懒加载：构造与 list 不抛错
  assert.ok(r.list().includes('nomodel'));
  // 首次访问才因缺 apiKey 抛错
  assert.throws(() => r.get(), /API_KEY/);
});

test('getJudge：judge.model 显式 + 主 provider=qwen → qwen 实例，缓存复用', () => {
  const r = new LLMRegistry(makeLLMCfg({ judge: { provider: '', model: 'qwen3.8-max' } }));
  const judge = r.getJudge();
  assert.ok(judge instanceof OpenAICompatProvider);
  assert.equal(judge.id, 'qwen', 'judge 应落在主 provider=qwen');
  assert.equal(r.getJudge(), judge, 'judge 实例应缓存复用');
});

test('getJudge：judge 可指定独立 provider（deepseek + 覆盖 model）', () => {
  const r = new LLMRegistry(
    makeLLMCfg({
      provider: 'qwen',
      judge: { provider: 'deepseek', model: 'deepseek-r1' },
      models: [
        ...makeLLMCfg().models,
        { id: 'deepseek', apiKey: 'sk-ds', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
      ],
    }),
  );
  const judge = r.getJudge();
  assert.ok(judge instanceof OpenAICompatProvider);
  assert.equal(judge.id, 'deepseek', 'judge 应使用指定的 deepseek provider');
});

test('getJudge：judge.model 未配置 → 跟随主 provider 的默认 model', () => {
  const r = new LLMRegistry(makeLLMCfg({ judge: { provider: '', model: '' } }));
  const judge = r.getJudge();
  assert.ok(judge instanceof OpenAICompatProvider);
  assert.equal(judge.id, 'qwen');
  assert.equal(r.getJudge(), r.getById('qwen'));
});

test('OpenAICompatProvider：缺 key/model 才抛错（构造校验）', () => {
  assert.throws(() => new OpenAICompatProvider('qwen', { apiKey: '', baseURL: 'x', model: 'm' }), /API_KEY/);
  assert.throws(() => new OpenAICompatProvider('qwen', { apiKey: 'k', baseURL: 'x', model: '' }), /MODEL/);
  assert.doesNotThrow(() => new OpenAICompatProvider('qwen', { apiKey: 'k', baseURL: 'x', model: 'm' }));
});