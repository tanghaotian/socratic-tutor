/**
 * 真实评测样本就绪度评估（OQ-7 阈值校准 + 真实数据回填）。
 *
 * 背景：评测阈值（OQ-7）历史上仅经 3 条冻结线程验证，而设计目标周抽样为 20–30 条。
 * 更关键的是：`data/threads/` 里混有**人工编写的种子线程**（`t-seed-*`，`npm run seed:threads` 产物），
 * 种子数据只能让评测链路开箱可跑，**不能用于阈值校准**（会得到虚高的「达标」结论）。
 *
 * 本脚本把「样本量是否够、有没有被种子数据污染」变成可量化、可复跑的检查，
 * 输出评定结论与退出码，供 CI / 交付验收使用：
 *   exit 0 = 真实样本已达周抽样目标；exit 1 = 未达标（不应据当前数据校准阈值）。
 *
 * 用法：
 *   node scripts/assess-eval-sample.mjs            # 人类可读报告
 *   node scripts/assess-eval-sample.mjs --json     # 机器可读
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.STORAGE_DIR ?? './data';
const THREADS_DIR = process.env.EVAL_THREADS_DIR ?? process.env.TRACING_DIR ?? './data/threads';
const GOLDEN_FILE = process.env.TRACING_GOLDEN_FILE ?? './data/threads/golden.json';
const TARGET = Number(process.env.EVAL_WEEKLY_SAMPLE ?? 25);
/** 种子线程 id 前缀（见 src/tracing/seed.ts `t-seed-<topic>-<day>-<seq>`） */
const SEED_PREFIX = 't-seed-';

function readThreads() {
  if (!fs.existsSync(THREADS_DIR)) return { threads: [], skipped: [], parseErrors: [] };
  const skip = new Set([path.basename(GOLDEN_FILE)]);
  const threads = [];
  const skipped = [];
  const parseErrors = [];
  for (const name of fs.readdirSync(THREADS_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    if (skip.has(name)) {
      skipped.push(name);
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(THREADS_DIR, name), 'utf-8'));
      threads.push({ file: name, ...raw });
    } catch (e) {
      parseErrors.push({ file: name, reason: e?.message ?? String(e) });
    }
  }
  return { threads, skipped, parseErrors };
}

function signalsOf(t) {
  return (t.turns ?? []).map((x) => x.signal).filter(Boolean);
}

const { threads, skipped, parseErrors } = readThreads();

const real = threads.filter((t) => !String(t.id ?? '').startsWith(SEED_PREFIX));
const seed = threads.filter((t) => String(t.id ?? '').startsWith(SEED_PREFIX));

const failureThreads = real.filter((t) => signalsOf(t).some((s) => s === 'mistake' || s === 'confused'));
const topics = new Set(real.map((t) => t.topic ?? 'general'));
const userTurns = real.reduce((n, t) => n + (t.turns ?? []).filter((x) => x.role === 'user').length, 0);
const nonAsciiTopic = real.filter((t) => /[^\w-]/.test(String(t.topic ?? '')));

const ready = real.length >= TARGET;
const reasons = [];
if (real.length === 0) reasons.push('无任何真实录制线程（评测当前只能跑在种子/桩样本上）');
else if (!ready) reasons.push(`真实线程 ${real.length} 条 < 周抽样目标 ${TARGET} 条`);
if (real.length > 0 && topics.size < 3) reasons.push(`真实线程仅覆盖 ${topics.size} 个主题，分层抽样代表性不足`);

const report = {
  generatedAt: new Date().toISOString(),
  threadsDir: path.resolve(THREADS_DIR),
  targetSampleSize: TARGET,
  counts: {
    total: threads.length,
    real: real.length,
    seed: seed.length,
    failureFirstReal: failureThreads.length,
    realUserTurns: userTurns,
    realTopics: topics.size,
  },
  verdict: ready ? 'ready' : 'insufficient',
  reasons,
  warnings: [
    ...(seed.length > 0
      ? [`存在 ${seed.length} 条人工种子线程（t-seed-*）：可让链路开箱可跑，但**不得**用于阈值校准；接真实使用后建议删除`]
      : []),
    ...(parseErrors.length ? [`${parseErrors.length} 个文件解析失败：${parseErrors.map((p) => p.file).join(', ')}`] : []),
    ...(nonAsciiTopic.length
      ? [`${nonAsciiTopic.length} 条真实线程主题名含非 ASCII（录制层 safeToken 归一为 _，会丢失主题分层信息）`]
      : []),
    ...(real.length > 0 && userTurns === real.length
      ? ['真实线程均为单轮（录制层按「一轮 user+agent」落盘）：冻结线程在评测中不体现连续信号，修复 BUG-004 后已具备生成多轮线程的数据基础（conversation_turns），建议后续补齐录制']
      : []),
  ],
  realThreads: real.map((t) => ({
    id: t.id,
    topic: t.topic ?? null,
    turns: (t.turns ?? []).length,
    signals: signalsOf(t),
  })),
  seedThreads: seed.map((t) => ({ id: t.id, topic: t.topic ?? null, turns: (t.turns ?? []).length })),
  skippedGolden: skipped,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = report.counts;
  console.log('\n=== 评测样本就绪度评估（OQ-7 / 真实数据回填） ===');
  console.log(`目录：${report.threadsDir}`);
  console.log(`线程总数：${c.total}（真实 ${c.real} / 种子 ${c.seed}）`);
  console.log(`真实样本：主题 ${c.realTopics} 个 · user 轮次 ${c.realUserTurns} · 失败型 ${c.failureFirstReal} 条`);
  console.log(`周抽样目标：${report.targetSampleSize} 条`);
  console.log(`\n评定：${report.verdict === 'ready' ? '✅ 已达目标' : '⛔ 未达标（不应据当前数据校准阈值）'}`);
  for (const r of report.reasons) console.log(`  - ${r}`);
  if (report.warnings.length) {
    console.log('\n警示：');
    for (const w of report.warnings) console.log(`  ! ${w}`);
  }
  if (report.skippedGolden.length) console.log(`\n已跳过（黄金数据集，避免重复计数）：${report.skippedGolden.join(', ')}`);
  console.log('');
}

process.exit(ready ? 0 : 1);
