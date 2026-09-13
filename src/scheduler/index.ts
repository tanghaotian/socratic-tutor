import cron, { type ScheduledTask } from 'node-cron';
import type { LLMProvider, ReminderProvider } from '../providers/index.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import { ReflectionEngine, type ReflectionEngineOptions } from '../engines/reflection.js';
import { config } from '../config.js';
import { withLock, type DistributedLock } from '../locks/index.js';

/**
 * 定时调度器（IT4）。
 * 按 cron 表达式（默认周五 19:00）触发每周反思；也可手动触发单次（供 /api/reflect）。
 * 幂等：同批不重复生成（见 ReflectionEngine）。
 * IT16：多节点下经分布式锁保证同一周期仅一个实例执行。
 */
export class Scheduler {
  private engine: ReflectionEngine;
  private task: ScheduledTask | null = null;

  constructor(
    llm: LLMProvider,
    store: SqliteStorage,
    private remind?: ReminderProvider,
    private lock?: DistributedLock,
  ) {
    this.engine = new ReflectionEngine(llm, store);
  }

  /** 启动每周定时反思（配置 REFLECTION_CRON，默认周五 19:00） */
  startWeekly(): void {
    if (this.task) return;
    const expr = config.reflection.cron;
    this.task = cron.schedule(
      expr,
      () => {
        void this.run('weekly');
      },
      { timezone: 'Asia/Shanghai' },
    );
    console.log(`[scheduler] 每周反思已调度: ${expr}`);
  }

  stopWeekly(): void {
    this.task?.stop();
    this.task = null;
  }

  /** 手动触发一次反思（默认 draft；opts 可携带上下文） */
  run(trigger: 'manual' | 'weekly' = 'manual', opts: ReflectionEngineOptions = { outputDir: config.storage.dir }): Promise<{
    report: import('../engines/reflection.js').ReflectionReport;
    markdownPath: string;
  }> {
    opts.outputDir = opts.outputDir ?? config.storage.dir;
    const doRun = () => this.engine.run(trigger, opts, this.remind);
    if (!this.lock) return doRun();
    return withLock(this.lock, `reflect:${trigger}`, defaultOwner(), doRun).then((res) => {
      if (!res) throw new Error('反思任务已被另一实例占锁，本次跳过');
      return res;
    });
  }

  /** 确认反思报告 */
  confirm(id: string): import('../engines/reflection.js').ReflectionReport {
    return this.engine.confirm(id);
  }
}

let _ownerId = '';
/** 锁所有者标识：本进程实例 id（多实例下各自唯一） */
export function defaultOwner(): string {
  if (!_ownerId) _ownerId = `inst-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return _ownerId;
}