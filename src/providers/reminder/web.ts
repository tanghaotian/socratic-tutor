import type { ReminderProvider } from '../interfaces.js';

/**
 * Web 提醒 Provider：把待办/提醒写入本地数据文件，Web 界面据此展示角标。
 * Phase 1 默认实现。
 */
export class WebReminderProvider implements ReminderProvider {
  readonly id = 'web' as const;

  constructor(private dataDir: string) {}

  async notify(title: string, content: string, target?: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.join(this.dataDir, 'reminders');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}.json`);
    const record = { title, content, target, createdAt: new Date().toISOString() };
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf-8');
    // 记录提醒操作日志
    console.log(`[reminder:web] ${title}`);
  }
}