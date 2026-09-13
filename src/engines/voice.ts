import type { ASRProvider, TTSProvider } from '../providers/index.js';
import { AudioStore } from '../storage/audio.js';

/**
 * 非实时语音闭环引擎（IT6）。
 * 链路：录音 Buffer → ASR 转文本 → 处理文本 → TTS 合成回复音频。
 * 输入的"文本处理"由调用方注入（Web 层复用 /api/chat 的苏格拉底流程）。
 */
export interface VoiceContext {
  asr: ASRProvider;
  tts: TTSProvider;
  audioStore: AudioStore;
  /** 文本处理回调：输入识别文本，返回需要播报的回复文本 */
  processText: (text: string) => Promise<string>;
}

export interface VoiceTurnResult {
  transcribedText: string;
  replyText: string;
  audioUrl: string | null;
}

/**
 * 处理一次语音回合：ASR → 对话 → TTS → 返回音频 URL。
 * ASR/TTS 任一失败时降级：不中断，音频 URL 为空（前端可退回文本展示）。
 */
export async function runVoiceTurn(
  ctx: VoiceContext,
  audio: Buffer,
  uploadName: string,
): Promise<VoiceTurnResult> {
  // 持久化上传的原始录音
  ctx.audioStore.save(uploadName, audio, 'wav');

  // 1) ASR 转文本
  let transcribedText = '';
  try {
    transcribedText = (await ctx.asr.transcribe(audio)).trim();
  } catch (e) {
    transcribedText = '';
    console.error('[voice] ASR 失败:', e instanceof Error ? e.message : e);
  }

  // 2) 文本处理（苏格拉底流程）
  const replyText = await ctx.processText(transcribedText);

  // 3) TTS 合成回复音频
  let audioUrl: string | null = null;
  try {
    const speech = await ctx.tts.synthesize(replyText);
    const rel = ctx.audioStore.save(`tts-${Date.now()}`, speech, 'wav');
    audioUrl = ctx.audioStore.toUrl(rel);
  } catch (e) {
    console.error('[voice] TTS 失败:', e instanceof Error ? e.message : e);
  }

  return { transcribedText, replyText, audioUrl };
}