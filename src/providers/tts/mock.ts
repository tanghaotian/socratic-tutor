import type { TTSProvider } from '../interfaces.js';

/**
 * 本地模拟 TTS（Phase1 占位，无 API key 时代替真实合成用于联调全链路）。
 * 生成一段极小且可播放的 WAV（静音），前端拿到音频 URL 即可播放控验证链路。
 */
export class MockTTSProvider implements TTSProvider {
  readonly id = 'mock-tts';

  async synthesize(_text: string): Promise<Buffer> {
    return buildSilentWav();
  }
}

/** 生成 0.5s 静音单声道 8kHz 16bit PCM 的 WAV（约 8KB，可播放） */
function buildSilentWav(): Buffer {
  const sampleRate = 8000;
  const seconds = 0.5;
  const dataLen = sampleRate * seconds; // 16bit mono → dataLen 字节
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt 块长度
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  // 其余为静音（0）
  return buf;
}