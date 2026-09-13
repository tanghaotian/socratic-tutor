import fs from 'node:fs';
import path from 'node:path';
import type { AnswerSignal } from '../providers/index.js';
import type { FrozenThread } from '../engines/eval/index.js';
import type { RecordedTurn } from './replay.js';

/**
 * 种子线程（seed threads）——IT16 录制层的**冷启动数据源**。
 *
 * 背景：录制层（ReplayRecorder）只产出「单轮 user + 单轮 agent」的线程，
 * 而评测回放（EvalGate / strategy-eval）需要多轮、含信号的冻结线程才有区分度。
 * 真实使用前 `data/threads/` 为空 → 周报/月报与策略评测跑在空集或桩样本上。
 *
 * 本模块提供**可直接使用的种子数据** + 落盘逻辑：把下列线程写成
 * `data/threads/*.json`（FrozenThread 标准格式，`loadFrozenThreads` 可直接读取）。
 * 种子数据为人工编写的**教学样例**（非真实用户流量），用途是让评测链路开箱可跑、
 * 并作为口径基线；接入真实使用后由录制层自动累积，种子数据可随时删除。
 */
export interface SeedThread {
  /** 主题（评测分层抽样按 topic 分层） */
  topic: string;
  turns: RecordedTurn[];
}

/** 内置种子线程：覆盖多主题与四类信号（correct/confused/mistake/divergent） */
export const SEED_THREADS: SeedThread[] = [
  {
    topic: 'pythagorean',
    turns: [
      { role: 'user', content: '勾股定理证明我不太懂，想不明白为什么直角边平方和等于斜边平方', signal: 'confused' },
      { role: 'agent', content: '我们先不急着证明。你能画一个直角三角形，并指出三条边分别对应哪个正方形面积吗？' },
      { role: 'user', content: '是不是可以用面积来解释？', signal: 'correct' },
      { role: 'agent', content: '很好，你抓住了关键——这个定理本质是面积关系。那两个小正方形的面积之和，与最大的那个是什么关系？' },
      { role: 'user', content: '那为什么作三个正方形就能证明呢？', signal: 'mistake' },
      { role: 'agent', content: '你其实已经在正确的路上了。试着把大正方形沿斜边重新切分一次，看看能得到什么？' },
    ],
  },
  {
    topic: 'calculus',
    turns: [
      { role: 'user', content: '导数的几何意义是什么？', signal: 'divergent' },
      { role: 'agent', content: '先想想一条曲线在某个点上的「陡峭程度」该怎么量。你能画出过该点的割线吗？' },
      { role: 'user', content: '斜率就是导数吧', signal: 'correct' },
      { role: 'agent', content: '方向对了。那么当割线的两个交点无限靠近时，割线会变成什么？' },
    ],
  },
  {
    topic: 'python',
    turns: [
      { role: 'user', content: '闭包的概念我混淆了', signal: 'mistake' },
      { role: 'agent', content: '我们先区分两个词：函数「定义」和函数「调用」。内层函数是在什么时候被定义的？' },
      { role: 'user', content: '是不是和函数作用域有关？', signal: 'correct' },
      { role: 'agent', content: '正是。那内层函数为什么在外层函数返回之后，还能访问到外层的变量？' },
    ],
  },
  {
    topic: 'probability',
    turns: [
      { role: 'user', content: '条件概率和独立事件我总搞混', signal: 'confused' },
      { role: 'agent', content: '如果两个事件独立，P(A|B) 与 P(A) 有什么关系？先凭直觉说。' },
      { role: 'user', content: '独立的话应该相等', signal: 'correct' },
      { role: 'agent', content: '对，这正是独立性的定义式。那如果不相等，说明 B 给了我们什么信息？' },
    ],
  },
];

/**
 * 把种子线程写入 `<threadsDir>/*.json`（FrozenThread 标准格式）。
 * 幂等：已存在同 id 文件时跳过；返回新写入数量。
 * 每个种子线程收敛为一个稳定 id，重复执行不会产生重复样本。
 */
export function seedThreads(threadsDir: string, threads: SeedThread[] = SEED_THREADS, when = new Date()): number {
  const day = when.toISOString().slice(0, 10).replace(/-/g, '');
  let written = 0;
  threads.forEach((t, idx) => {
    const id = `t-seed-${safeToken(t.topic)}-${day}-${String(idx + 1).padStart(3, '0')}`;
    const file = path.join(threadsDir, `${id}.json`);
    if (fs.existsSync(file)) return; // 幂等
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(toFrozenThread(id, t), null, 2), 'utf-8');
    written += 1;
  });
  return written;
}

/** SeedThread → FrozenThread（多轮，保持 user/agent 交替与信号） */
export function toFrozenThread(id: string, seed: SeedThread): FrozenThread {
  return { id, topic: seed.topic, turns: seed.turns };
}

function safeToken(v: string): string {
  return v.replace(/[^\w-]/g, '_').slice(0, 40) || 'general';
}

/** 供调用方按需导入的信号类型（保持与录制层一致） */
export type { AnswerSignal };
