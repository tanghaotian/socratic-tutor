import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoubaoASRProvider } from '../src/providers/asr/doubao.js';

/** 构造一个受控的 fetch 响应（含 X-Api-Status-Code 头） */
function fakeResponse(opts: {
  status?: number;
  apiStatus?: string;
  body?: unknown;
  text?: string;
}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (opts.apiStatus) headers.set('X-Api-Status-Code', opts.apiStatus);
  return new Response(opts.text ?? JSON.stringify(opts.body ?? {}), {
    status: opts.status ?? 200,
    headers,
  });
}

/** 临时替换 globalThis.fetch，返回捕获到的请求体，并在结束时还原 */
async function withFetch(
  impl: (url: string, init: RequestInit) => Response,
  fn: (captured: { url: string; init: RequestInit }) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const captured: { url: string; init: RequestInit } = { url: '', init: {} };
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    captured.url = String(url);
    captured.init = (init ?? {}) as RequestInit;
    return impl(String(url), (init ?? {}) as RequestInit);
  }) as typeof fetch;
  try {
    await fn(captured);
  } finally {
    globalThis.fetch = original;
  }
}

const provider = new DoubaoASRProvider({ appid: 'app-id', accessToken: 'token' });

test('ASR 解析：优先拼接 result.utterances 逐句文本（大模型版真实返回形态）', async () => {
  await withFetch(
    () =>
      fakeResponse({
        apiStatus: '20000000',
        body: {
          result: {
            text: '整段兜底文本',
            utterances: [{ text: '勾股定理' }, { text: '为什么要平方' }, { text: '  ' }],
          },
        },
      }),
    async (cap) => {
      const text = await provider.transcribe(Buffer.from([1, 2, 3]));
      // utterances 存在时以其为准（空句被过滤），不回退整段 text
      assert.equal(text, '勾股定理\n为什么要平方');
      // 请求体应带 audio.format 与鉴权/资源头
      const body = JSON.parse(String(cap.init.body));
      assert.equal(body.audio.format, 'wav');
      assert.equal(body.request.model_name, 'bigmodel');
      const headers = cap.init.headers as Record<string, string>;
      assert.equal(headers['X-Api-App-Key'], 'app-id');
      assert.equal(headers['X-Api-Access-Key'], 'token');
      assert.equal(headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo');
      assert.ok(cap.url.includes('/api/v3/auc/bigmodel/recognize/flash'));
    },
  );
});

test('ASR 解析：无 utterances 时回退整段 result.text', async () => {
  await withFetch(
    () => fakeResponse({ apiStatus: '20000000', body: { result: { text: '  整段识别文本  ' } } }),
    async () => {
      assert.equal(await provider.transcribe(Buffer.from([1])), '整段识别文本');
    },
  );
});

test('ASR 解析：格式非法（format）可覆盖，且请求头随之透传', async () => {
  const mp3 = new DoubaoASRProvider({ appid: 'a', accessToken: 't', format: 'mp3', resourceId: 'res-x' });
  await withFetch(
    () => fakeResponse({ apiStatus: '20000000', body: { result: { text: 'ok' } } }),
    async (cap) => {
      await mp3.transcribe(Buffer.from([1]));
      const body = JSON.parse(String(cap.init.body));
      assert.equal(body.audio.format, 'mp3');
      assert.equal((cap.init.headers as Record<string, string>)['X-Api-Resource-Id'], 'res-x');
    },
  );
});

test('ASR 静音（20000003）返回空文本而非抛错，交由上层降级', async () => {
  await withFetch(
    () => fakeResponse({ apiStatus: '20000003', body: {} }),
    async () => {
      assert.equal(await provider.transcribe(Buffer.from([0])), '');
    },
  );
});

test('ASR 业务错误码：非 20000000 抛错并带状态码', async () => {
  await withFetch(
    () => fakeResponse({ status: 200, apiStatus: '40000001', text: '{"message":"bad audio"}' }),
    async () => {
      await assert.rejects(
        () => provider.transcribe(Buffer.from([1])),
        /X-Api-Status=40000001/,
      );
    },
  );
});

test('ASR 无识别结果：20000000 但文本为空时抛错（区别于静音分支）', async () => {
  await withFetch(
    () => fakeResponse({ apiStatus: '20000000', body: { result: {} } }),
    async () => {
      await assert.rejects(() => provider.transcribe(Buffer.from([1])), /无识别结果/);
    },
  );
});

test('ASR 未配置凭据时立即抛错（不发请求）', async () => {
  const unconfigured = new DoubaoASRProvider({});
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return fakeResponse({});
  }) as typeof fetch;
  try {
    await assert.rejects(() => unconfigured.transcribe(Buffer.from([1])), /ASR 未配置/);
    assert.equal(called, false, '未配置时不应发出请求');
  } finally {
    globalThis.fetch = original;
  }
});
