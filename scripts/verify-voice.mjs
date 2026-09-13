/**
 * 语音链路自检（ASR/TTS 真实 provider 联调）。
 *
 * 用途：在配置真实语音凭据后，验证「TTS 合成 → 落盘 → ASR 转写」闭环可用。
 * 用法：
 *   npm run build && npm run voice:verify
 *
 * 未配置凭据时不会失败退出，而是明确告知当前处于 Mock 占位模式（退出码 0）；
 * 配置了凭据但调用失败时退出码 1，便于 CI/人工判断。
 */
import fs from 'node:fs';
import { config } from '../dist/config.js';
import { initProviders } from '../dist/providers/index.js';

const providers = initProviders(config);
const tts = providers.getTTS();
const asr = providers.getASR();

const outDir = 'data/voice-verify';
const text = '你好，我是苏格拉底助教，请跟我一起思考这个问题。';

console.log('[voice-verify] TTS Provider:', tts.id);
console.log('[voice-verify] ASR Provider:', asr.id);

const isMock = tts.id.startsWith('mock') || asr.id.startsWith('mock');
if (isMock) {
  console.warn(
    '\n[voice-verify] 当前为 Mock 占位模式：未配置真实语音凭据，无法验证真实链路。\n' +
      '  需设置 ASR_APPID / ASR_ACCESS_TOKEN 与 TTS_APPID / TTS_ACCESS_TOKEN（见 .env.example），\n' +
      '  随后重启服务或重新执行本命令。',
  );
  process.exit(0);
}

try {
  // 1) TTS 合成 → wav 落盘
  const audio = await tts.synthesize(text);
  fs.mkdirSync(outDir, { recursive: true });
  const wavPath = `${outDir}/tts-out.wav`;
  fs.writeFileSync(wavPath, audio);
  console.log(`[voice-verify] TTS 合成成功: ${audio.length} bytes → ${wavPath}`);

  // 2) ASR 转写该 wav → 文本（验证真实识别链路）
  const transcript = await asr.transcribe(audio);
  console.log(`[voice-verify] ASR 转写结果: "${transcript}"`);

  // 3) 一致性检查：转写非空即认为闭环可用
  const ok = transcript.replace(/[\s，。？！,.!?]/g, '') !== '';
  console.log(`\n[voice-verify] TTS→ASR 闭环: ${ok ? '通过' : '失败（转写为空）'}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`\n[voice-verify] 失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
