import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVoiceTurn, type VoiceContext } from '../src/engines/voice.js';
import { MockASRProvider } from '../src/providers/asr/mock.js';
import { MockTTSProvider } from '../src/providers/tts/mock.js';
import { AudioStore } from '../src/storage/audio.js';

function setup(): { ctx: VoiceContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-voice-'));
  const asr = new MockASRProvider();
  const tts = new MockTTSProvider();
  const audioStore = new AudioStore(dir);
  return { dir, ctx: { asr, tts, audioStore, processText: async (t) => `回复:${t}` } };
}

test('语音全链路：录音→ASR→文本→TTS→音频URL', async () => {
  const { ctx, dir } = setup();
  try {
    const fakeAudio = Buffer.from([0, 1, 2, 3]);
    const result = await runVoiceTurn(ctx, fakeAudio, 'rec-1');
    // ASR（mock）→ 文本，文本处理后返回回复
    assert.ok(result.transcribedText.length > 0);
    assert.match(result.replyText, /^回复:/);
    // TTS（mock）产出可播放 WAV 并落盘，供 URL 访问
    assert.ok(result.audioUrl, '应生成音频 URL');
    assert.match(result.audioUrl!, /^\/audio\/tts-.*\.wav$/);
    const abs = path.join(dir, result.audioUrl!.replace(/^\//, ''));
    assert.ok(fs.existsSync(abs));
    const head = fs.readFileSync(abs);
    assert.equal(head.subarray(0, 4).toString(), 'RIFF');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ASR 失败降级：文本为空仍返回回复，音频可为空', async () => {
  const { ctx, dir } = setup();
  try {
    const ctxBroken: VoiceContext = {
      ...ctx,
      asr: { id: 'broken', transcribe: async () => { throw new Error('asr down'); } },
      processText: async () => '降级回复',
    };
    const result = await runVoiceTurn(ctxBroken, Buffer.from([1]), 'rec-2');
    assert.ok(await result.transcribedText === '');
    assert.equal(result.replyText, '降级回复');
    // TTS 仍可成功（mock），音频 URL 存在
    assert.ok(result.audioUrl);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});