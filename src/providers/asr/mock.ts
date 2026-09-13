import type { ASRProvider } from '../interfaces.js';

/**
 * 本地模拟 ASR（Phase1 占位，无 API key 时代替真实识别用于联调全链路）。
 * 不做真实转写，把传入的音频当作"已识别"并返回占位文本。
 */
export class MockASRProvider implements ASRProvider {
  readonly id = 'mock-asr';

  constructor(private placeholder = '（模拟语音转写：请配置真实 ASR 获取识别文本）') {}

  async transcribe(_audio: Buffer): Promise<string> {
    return this.placeholder;
  }
}