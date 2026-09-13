/**
 * 冷启动数据源：把内置教学种子线程写入 data/threads/（FrozenThread 标准格式）。
 *
 * 用途：真实使用前让评测回放（EvalGate / strategy-eval、周报/月报）拿到多轮含信号的
 * 冻结线程，避免跑在空集或桩样本上。幂等，可重复执行。
 *
 * 用法：
 *   npm run build && npm run seed:threads
 *
 * 注意：种子数据为人工编写的**教学样例**，不是真实用户流量；接入真实使用后由录制层
 * 自动累积真实线程，种子文件可随时删除（见 README「真实数据回填」）。
 */
import path from 'node:path';
import { config } from '../dist/config.js';
import { seedThreads, SEED_THREADS } from '../dist/tracing/index.js';
import { loadFrozenThreads } from '../dist/scheduler/eval-cron.js';

const dir = config.eval.threadsDir;
const written = seedThreads(dir);
const all = loadFrozenThreads(dir, [path.basename(config.tracing.goldenFile)]);
const topics = [...new Set(all.map((t) => t.topic).filter(Boolean))];

console.log(`[seed:threads] 目录: ${dir}`);
console.log(`[seed:threads] 本次新写入: ${written} 个（内置种子 ${SEED_THREADS.length} 个，已存在则跳过）`);
console.log(`[seed:threads] 目录内可加载冻结线程: ${all.length} 个，覆盖主题: ${topics.join(', ') || '(无)'}`);
if (all.length === 0) {
  console.warn('[seed:threads] 警告：目录内没有任何可加载线程，评测将回退桩样本。');
  process.exit(1);
}
