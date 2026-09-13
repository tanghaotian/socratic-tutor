import fs from 'node:fs';
import path from 'node:path';
import type { FrozenThread } from '../engines/eval/index.js';
import { sampleThreads, type SamplerOptions } from './sample.js';
import { ReplayRecorder } from './replay.js';

/**
 * 黄金数据集维护（IT16，详见 detail.md §10）。
 * `golden` 可对全部录制线程做增量抽样 + 审计，输出可直接被 `loadFrozenThreads`
 * （`scheduler/eval-cron.ts`）读取的样本集合，作为评测/自我更新的基准。
 *
 * 存储形态：`<goldenFile>` 为 FrozenThread[] 的 JSON 数组文件（与 `data/threads/` 单线程文件并存，
 * 但作为"挑选后的黄金样本"快速加载源）。
 */
export class GoldenDataset {
  constructor(
    private goldenFile: string,
    private recorder: ReplayRecorder,
  ) {}

  /** 现有黄金样本（无则空数组） */
  load(): FrozenThread[] {
    if (!fs.existsSync(this.goldenFile)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.goldenFile, 'utf-8'));
      return Array.isArray(data) ? (data as FrozenThread[]) : [];
    } catch {
      return [];
    }
  }

  /** 是否有黄金样本 */
  exists(): boolean {
    return fs.existsSync(this.goldenFile);
  }

  /**
   * 从 threadsDir 的全部录制线程中抽样刷新黄金样本（增量：保留已有 + 追加新样本）。
   * 返回新落盘路径。`opts.size` 控制该批次规模上限。
   */
  async refresh(allThreads: FrozenThread[], opts: SamplerOptions): Promise<string> {
    fs.mkdirSync(path.dirname(this.goldenFile), { recursive: true });
    const existing = this.load();
    const existIds = new Set(existing.map((t) => t.id));
    const newOnes = allThreads.filter((t) => !existIds.has(t.id));
    const picked = await sampleThreads(newOnes, opts);
    const merged = [...existing, ...picked];
    fs.writeFileSync(this.goldenFile, JSON.stringify(merged, null, 2), 'utf-8');
    // 审计同步落盘：避免重复文件，直接以黄金样本为准（单个线程文件已由 recorder 维护）
    return this.goldenFile;
  }

  /** 手动将指定线程加入黄金样本（幂等） */
  add(thread: FrozenThread): boolean {
    fs.mkdirSync(path.dirname(this.goldenFile), { recursive: true });
    if (fs.existsSync(this.goldenFile)) {
      const list = this.load();
      if (list.some((t) => t.id === thread.id)) return false;
      list.push(thread);
      fs.writeFileSync(this.goldenFile, JSON.stringify(list, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(this.goldenFile, JSON.stringify([thread], null, 2), 'utf-8');
    }
    return true;
  }
}