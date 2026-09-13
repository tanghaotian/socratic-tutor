import { randomUUID } from 'node:crypto';
import type { TTSProvider } from '../interfaces.js';

/**
 * 豆包（火山引擎）语音合成 Provider —— 非实时。
 * 使用经典同步合成 HTTP 接口（历史接口，稳定且一次请求返回音频）：
 *   POST https://openspeech.bytedance.com/api/v1/tts
 * 鉴权：Authorization: Bearer;<access_token>，body 内 app.appid / app.token / app.cluster。
 * 输出 wav 编码以匹配语音链路落盘约定（AudioStore 统一 .wav 后缀）。
 * 音色：cluster 默认 volcano_tts；voice_type 默认 BV001_streaming（经典女声，可经 TTS_VOICE_TYPE 配置）。
 */
export class DoubaoTTSProvider implements TTSProvider {
  readonly id = 'doubao-tts';

  constructor(
    private opts: {
      appid?: string;
      accessToken?: string;
      cluster?: string;
      voiceType?: string;
    },
  ) {}

  async synthesize(text: string): Promise<Buffer> {
    if (!this.opts.appid || !this.opts.accessToken) {
      throw new Error('TTS 未配置：请设置 TTS_APPID / TTS_ACCESS_TOKEN');
    }
    const url = 'https://openspeech.bytedance.com/api/v1/tts';
    const body = JSON.stringify({
      app: {
        appid: this.opts.appid,
        token: this.opts.accessToken,
        cluster: this.opts.cluster ?? 'volcano_tts',
      },
      user: { uid: this.opts.appid },
      audio: {
        voice_type: this.opts.voiceType ?? 'BV001_streaming',
        encoding: 'wav',
        rate: 24000,
        speed_ratio: 1.0,
        volume_ratio: 1.0,
        pitch_ratio: 1.0,
      },
      request: {
        reqid: randomUUID(),
        text,
        text_type: 'plain',
        operation: 'query',
      },
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer;${this.opts.accessToken}`,
      },
      body,
    });
    const json = (await resp.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: string;
    } | null;
    if (!resp.ok || !json || json.code !== 0 || typeof json.data !== 'string') {
      throw new Error(
        `火山 TTS 失败: HTTP ${resp.status} code=${json?.code ?? 'n/a'} message=${json?.message ?? resp.statusText}`,
      );
    }
    return Buffer.from(json.data, 'base64');
  }
}
