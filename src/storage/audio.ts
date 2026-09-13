import fs from 'node:fs';
import path from 'node:path';

/**
 * 音频文件持久化（IT6，Phase1 非实时）。
 * 上传的原始录音与 TTS 合成音频统一落盘到 data/audio，避免散落写文件。
 */
export class AudioStore {
  constructor(private baseDir: string) {
    this.dir = path.join(baseDir, 'audio');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private dir: string;

  /** 保存音频，返回相对路径（如 audio/1623.wav），供 URL 访问 */
  save(name: string, data: Buffer, ext = 'wav'): string {
    const file = `${name}.${ext}`;
    fs.writeFileSync(path.join(this.dir, file), data);
    return `audio/${file}`;
  }

  /** 将相对路径解析为绝对磁盘路径（用于读回） */
  resolve(relative: string): string {
    return path.join(this.baseDir, relative);
  }

  /** 将相对路径映射为浏览器可访问的 URL（/audio/...） */
  toUrl(relative: string): string {
    return `/${relative.replace(/\\/g, '/')}`;
  }
}