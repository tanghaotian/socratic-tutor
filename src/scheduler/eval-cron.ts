import cron, { type ScheduledTask } from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../providers/index.js';
import { config } from '../config.js';
import type { ActiveSkill } from '../engines/skills/index.js';
import { runEvalGate, type FrozenThread, type EvalEngine } from '../engines/eval/index.js';
import { withLock, type DistributedLock } from '../locks/index.js';
import { defaultOwner } from './index.js';

/**
 * 从目录加载冻结线程（每个 *.json 可为单个线程或线程数组）。
 *
 * `skipFiles`：需跳过的文件名（basename）。黄金数据集默认落在
 * `data/threads/golden.json`——它是**已选样本的汇总副本**，若一并加载会导致
 * 同一条线程被计入两次，虚增样本量并污染报告，故默认跳过 `golden.json`。
 */
export function loadFrozenThreads(dir: string, skipFiles: string[] = ['golden.json']): FrozenThread[] {
  if (!fs.existsSync(dir)) return [];
  const skip = new Set(skipFiles);
  const out: FrozenThread[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || skip.has(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (Array.isArray(data)) out.push(...(data as FrozenThread[]));
      else if (data && typeof data.id === 'string') out.push(data as FrozenThread);
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out;
}

/** 从快照目录读某引擎的 baseline/candidate 激活 skill 快照（无则 null） */
function loadSnapshotSkills(dir: string, engine: EvalEngine, which: 'baseline' | 'candidate'): ActiveSkill[] | null {
  const file = path.join(dir, `${engine}.${which}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data) ? (data as ActiveSkill[]) : null;
  } catch {
    return null;
  }
}

/**
 * 评测定时调度器（IT10，detail.md §9.4）。
 * 每周抽样 / 每月全量：从快照目录读 baseline/candidate skill 组合，
 * 从线程目录读冻结线程，跑 EvalGate 出周报/月报。无快照时跳过（打印提示）。
 */
export class EvalScheduler {
  private tasks: ScheduledTask[] = [];

  constructor(private llm: LLMProvider, private lock?: DistributedLock) {}

  /** 启动每周抽样 + 每月全量评测调度 */
  start(): void {
    if (this.tasks.length > 0) return;
    const tz = 'Asia/Shanghai';
    this.tasks.push(
      cron.schedule(
        config.eval.weeklyCron,
        () => void this.runCron('weekly'),
        { timezone: tz },
      ),
    );
    this.tasks.push(
      cron.schedule(
        config.eval.monthlyCron,
        () => void this.runCron('monthly'),
        { timezone: tz },
      ),
    );
    console.log(`[scheduler] 评测调度已启动: 周报 ${config.eval.weeklyCron} / 月报 ${config.eval.monthlyCron}`);
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }

  private async runCron(kind: 'weekly' | 'monthly'): Promise<void> {
    const doRun = async () => {
      const snapDir = path.join(config.eval.outputDir, 'snapshots');
      const threads = loadFrozenThreads(config.eval.threadsDir, [path.basename(config.tracing.goldenFile)]);
      if (threads.length === 0) {
        console.log('[scheduler] 评测跳过：无冻结线程（data/threads 为空）');
        return;
      }
      for (const engine of ['socratic', 'profile'] as EvalEngine[]) {
        const baseline = loadSnapshotSkills(snapDir, engine, 'baseline');
        const candidate = loadSnapshotSkills(snapDir, engine, 'candidate');
        if (!baseline || !candidate) {
          console.log(`[scheduler] 评测跳过：${engine} 缺少快照（data/evals/snapshots）`);
          continue;
        }
        const sampled = kind === 'weekly' ? threads.slice(0, config.eval.weeklySample) : threads;
        const { report, file } = await runEvalGate({
          engine,
          baselineSkills: baseline,
          candidateSkills: candidate,
          threads: sampled,
          kind,
          sampledFrom: threads.length,
          judgeProvider: this.llm,
          backendId: config.eval.backend,
          outputDir: config.eval.outputDir,
        });
        console.log(`[scheduler] 评测完成 ${engine}/${kind}: verdict=${report.verdict} → ${file}`);
      }
    };
    if (!this.lock) return doRun();
    await withLock(this.lock, `eval:${kind}`, defaultOwner(), doRun);
  }

  /** 手动触发一次评测（供 /api/eval/run 或调试） */
  async runOnce(
    opts: {
      engine: EvalEngine;
      baselineSkills: ActiveSkill[];
      candidateSkills: ActiveSkill[];
      threads: FrozenThread[];
      kind?: 'weekly' | 'monthly';
      backendId?: string;
    },
  ): Promise<{ file: string; verdict: string }> {
    const { report, file } = await runEvalGate({
      engine: opts.engine,
      baselineSkills: opts.baselineSkills,
      candidateSkills: opts.candidateSkills,
      threads: opts.threads,
      kind: opts.kind ?? 'weekly',
      sampledFrom: opts.threads.length,
      judgeProvider: this.llm,
      backendId: opts.backendId ?? config.eval.backend,
      outputDir: config.eval.outputDir,
    });
    return { file, verdict: report.verdict };
  }
}
