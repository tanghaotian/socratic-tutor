import { randomUUID } from 'node:crypto';
import type { ASRProvider } from '../interfaces.js';

/**
 * 豆包（火山引擎）语音识别 Provider —— 非实时整段转写。
 * 使用「录音文件识别极速版」HTTP 接口（大模型版，一次请求即返回识别结果，无需轮询/WebSocket）：
 *   POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
 * 鉴权（旧版控制台）：X-Api-App-Key=APP ID + X-Api-Access-Key=Access Token；
 * 新版控制台单 key 用户可用 X-Api-Key 替代（本项目沿用 appid+token 两字段配置）。
 * 资源 ID 固定 volc.bigasr.auc_turbo（需在控制台开通该资源）。
 */
export class DoubaoASRProvider implements ASRProvider {
  readonly id = 'doubao-asr';

  constructor(
    private opts: {
      appid?: string;
      accessToken?: string;
      /** 资源 ID（默认 volc.bigasr.auc_turbo，需在控制台开通） */
      resourceId?: string;
      /** 音频容器格式，默认 wav（前端录音落盘统一为 wav） */
      format?: string;
    },
  ) {}

  async transcribe(audio: Buffer): Promise<string> {
    if (!this.opts.appid || !this.opts.accessToken) {
      throw new Error('ASR 未配置：请设置 ASR_APPID / ASR_ACCESS_TOKEN');
    }
    const url = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
    const body = JSON.stringify({
      user: { uid: this.opts.appid },
      audio: { format: this.opts.format ?? 'wav', data: audio.toString('base64') },
      request: { model_name: 'bigmodel', enable_itn: true },
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Key': this.opts.appid,
        'X-Api-Access-Key': this.opts.accessToken,
        'X-Api-Resource-Id': this.opts.resourceId ?? 'volc.bigasr.auc_turbo',
        'X-Api-Request-Id': randomUUID(),
        'X-Api-Sequence': '-1',
      },
      body,
    });
    const apiStatus = resp.headers.get('X-Api-Status-Code') ?? '';
    // 20000003 = 静音/无有效语音：属正常业务结果，返回空文本交由上层降级，不抛错
    if (apiStatus === '20000003') return '';
    if (!resp.ok || (apiStatus && apiStatus !== '20000000')) {
      const detail = await resp.text().catch(() => '');
      throw new Error(
        `火山 ASR 失败: HTTP ${resp.status} X-Api-Status=${apiStatus} ${detail.slice(0, 200)}`,
      );
    }
    const data = (await resp.json()) as {
      result?: { text?: string; utterances?: { text?: string }[] };
      message?: string;
    };
    // 结果文本优先取 utterances 逐句拼接（大模型版真实返回形态），
    // 缺失时回退整段 result.text。
    const text = buildText(data.result);
    if (!text) {
      throw new Error(`火山 ASR 无识别结果: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return text;
  }
}

/** 从识别结果中提取文本：utterances 逐句优先，回退整段 text */
function buildText(result?: { text?: string; utterances?: { text?: string }[] }): string {
  const fromUtterances = (result?.utterances ?? [])
    .map((u) => u?.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  if (fromUtterances) return fromUtterances;
  return result?.text?.trim() ?? '';
}
