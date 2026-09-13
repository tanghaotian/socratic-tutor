import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';

/**
 * 分布式锁（IT16，详见 detail.md §10「多节点」）。
 * 用途：多实例部署时，同一定时任务（反思/评测/复盘）只允许一个实例执行，避免重复。
 *
 * 后端：
 * - `single`（默认）：进程内锁，适合单节点。
 * - `file`：锁文件 + mtime 过期（TTL），适合多进程同机 / NFS。
 * - `db`：SQLite 锁表 + 过期时间，适合多节点共享存储库（可用 SQLite 文件在共享盘）。
 *
 * 均为"租约"式：持锁写入所有者 + 过期时间；过期自动让渡（防崩溃残留）。
 */
export interface DistributedLock {
  /** 尝试获取锁；成功返回 true，已被他人持锁返回 false。 */
  acquire(name: string, owner: string): boolean;
  /** 释放锁；仅当自己持有才释放。 */
  release(name: string, owner: string): void;
}

/** 文件/内存锁的持久化条目 */
interface LockEntry {
  owner: string;
  expiresAt: number; // epoch ms
}

class SingleProcessLock implements DistributedLock {
  private held = new Map<string, LockEntry>();

  acquire(name: string, owner: string): boolean {
    const now = Date.now();
    const cur = this.held.get(name);
    if (cur && now < cur.expiresAt && cur.owner !== owner) return false;
    this.held.set(name, { owner, expiresAt: now + this.ttl });
    return true;
  }

  release(name: string, owner: string): void {
    const cur = this.held.get(name);
    if (cur && cur.owner === owner) this.held.delete(name);
  }

  constructor(private ttl: number) {}
}

class FileLock implements DistributedLock {
  constructor(private lockDir: string, private ttl: number) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  private file(name: string): string {
    const safe = name.replace(/[^\w-]/g, '_');
    return path.join(this.lockDir, `${safe}.lock`);
  }

  acquire(name: string, owner: string): boolean {
    const file = this.file(name);
    const now = Date.now();
    // 尝试"原子"创建；若已存在且未过期，视为被占用
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ owner, expiresAt: now + this.ttl }));
      fs.closeSync(fd);
      return true;
    } catch {
      // 文件已存在：检查是否过期
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const entry: LockEntry = JSON.parse(raw);
        if (now < entry.expiresAt) return false; // 仍被他人持有
        // 过期：尝试接管（防并发：用 'wx' 无法原子覆盖，改为删除后重试一次）
        fs.unlinkSync(file);
        return this.acquire(name, owner);
      } catch {
        return false;
      }
    }
  }

  release(name: string, owner: string): void {
    const file = this.file(name);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const entry: LockEntry = JSON.parse(raw);
      if (entry.owner === owner) fs.unlinkSync(file);
    } catch {
      /* 已不存在则忽略 */
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

class DbLock implements DistributedLock {
  private db: DatabaseSync;

  constructor(dbPath: string, private ttl: number) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS locks (
      name TEXT PRIMARY KEY,
      owner TEXT,
      expiresAt INTEGER
    )`);
  }

  acquire(name: string, owner: string): boolean {
    const now = Date.now();
    this.db.prepare('DELETE FROM locks WHERE name=? AND expiresAt < ?').run(name, now); // 清理过期
    try {
      this.db.prepare('INSERT INTO locks(name, owner, expiresAt) VALUES(?,?,?)').run(
        name, owner, now + this.ttl,
      );
      return true;
    } catch {
      return false; // 主键冲突 = 已被持有
    }
  }

  release(name: string, owner: string): void {
    const row = this.db.prepare('SELECT owner FROM locks WHERE name=?').get(name) as AnyRecord | undefined;
    if (row && row.owner === owner) {
      this.db.prepare('DELETE FROM locks WHERE name=?').run(name);
    }
  }
}

/** 便捷包装：为一段异步任务加锁，避免重复执行。获得锁并执行成功返回任务结果，未获锁返回 null。 */
export async function withLock<T>(
  lock: DistributedLock,
  name: string,
  owner: string,
  task: () => Promise<T> | T,
): Promise<T | null> {
  if (!lock.acquire(name, owner)) return null;
  try {
    return await task();
  } finally {
    lock.release(name, owner);
  }
}

export type LockBackend = 'single' | 'file' | 'db';

/** 根据配置创建分布式锁实例 */
export function createDistributedLock(cfg: AppConfig['deploy']): DistributedLock {
  switch (cfg.lockBackend) {
    case 'file':
      return new FileLock(cfg.lockDir, cfg.lockTtlMs);
    case 'db':
      return new DbLock(path.join(cfg.lockDir, 'locks.db'), cfg.lockTtlMs);
    case 'single':
    default:
      return new SingleProcessLock(cfg.lockTtlMs);
  }
}