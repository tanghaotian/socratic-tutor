import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDistributedLock, withLock, type DistributedLock } from '../src/locks/index.js';
import type { AppConfig } from '../src/config.js';

function lockCfg(overrides: Partial<AppConfig['deploy']> & { ttl?: number }): AppConfig['deploy'] {
  return {
    mode: overrides.mode ?? 'single',
    lockBackend: overrides.lockBackend ?? 'single',
    lockDir: overrides.lockDir ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-lock-')), 'locks'),
    lockTtlMs: overrides.ttl ?? 300000,
  };
}

test('AC3 single 锁：同任务多实例并发放 只有一个执行', async () => {
  const lock = createDistributedLock(lockCfg({ lockBackend: 'single' }));
  let executed = 0;
  const owners = ['inst-A', 'inst-B', 'inst-C'];
  const results = await Promise.all(
    owners.map((owner) =>
      withLock(lock, 'task:weekly', owner, () => {
        executed++;
      }),
    ),
  );
  const ran = results.filter((r) => r !== null).length;
  assert.equal(ran, 1, '三实例并发放锁，仅一个获得执行权');
  assert.equal(executed, 1);
});

test('AC3 file 锁：文件后端并发抢占只执行一次且 TTL 过期可释放', async () => {
  const lock = createDistributedLock(lockCfg({ lockBackend: 'file', ttl: 200 }));
  let executed = 0;
  const results = await Promise.all(
    ['pid-1', 'pid-2', 'pid-3'].map((owner) =>
      withLock(lock, 'task:monthly', owner, () => { executed++; return owner; }),
    ),
  );
  const ran = results.filter((r) => r !== null).length;
  assert.equal(ran, 1, '三进程并发放锁仅一个执行');
  assert.equal(executed, 1);
  // TTL 过期后（模拟崩溃残留）可再获取
  await new Promise((r) => setTimeout(r, 250));
  const r = await withLock(lock, 'task:monthly', 'pid-9', () => { executed++; return 'ok2'; });
  assert.equal(r, 'ok2');
  assert.equal(executed, 2);
});

test('AC3 db 锁：SQLite 后端并发抢占互斥', async () => {
  const lock = createDistributedLock(lockCfg({ lockBackend: 'db' }));
  let executed = 0;
  const results = await Promise.all(
    ['n1', 'n2', 'n3'].map((owner) =>
      withLock(lock, 'task:reflect', owner, () => { executed++; return owner; }),
    ),
  );
  const ran = results.filter((r) => r !== null).length;
  assert.equal(ran, 1, '并发放锁仅一个执行');
  assert.equal(executed, 1);
});

test('AC3 锁类型断言：createDistributedLock 按后端返回可用实例', () => {
  for (const backend of ['single', 'file', 'db'] as const) {
    const lock = createDistributedLock(lockCfg({ lockBackend: backend }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (lock as DistributedLock);
    assert.ok(typeof lock.acquire === 'function' && typeof lock.release === 'function');
  }
});