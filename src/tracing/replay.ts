import fs from 'node:fs';
import path from 'node:path';
import type { AnswerSignal } from '../providers/index.js';
import type { FrozenThread } from '../engines/eval/index.js';

/**
 * 生产流量录制层（IT16，详见 detail.md §10「多节点」）。
 *
 * 目标：把真实对话（一轮 user 输入 + agent 回复 + 信号）录制为 **冻结线程（FrozenThread）**，
 * 写入 `data/threads/`，供评测放回（EvalScheduler/loadFrozenThreads）与自我更新采样（sampler/golden）使用。
 * 幂等去重：以 threadId 为准，不重复落盘。
 */
export interface RecordedTurn {
  role: 'user' | 'agent';
  content: string;
  signal?: AnswerSignal;
}

/** 录制请求：一轮对话的完整上下文 */
export interface ReplayRecorderInput {
  threadId: string; // 稳定 id（如 `${learnerId}-${topicId}-${date}`），用于幂等去重
  topic?: string;
  userText: string;
  agentText: string; // 本次教学动作文案（可空，如画像侧无产出）
  signal?: AnswerSignal;
}

export class ReplayRecorder {
  constructor(private threadsDir: string) {}

  /** 追加一条已结束的对话线程；返回是否"新写入"（false=重复/禁用）。幂等：同 id 不重复。 */
  record(input: ReplayRecorderInput): boolean {
    const file = this.fileFor(input.threadId);
    if (fs.existsSync(this.threadsDir) && fs.existsSync(file)) return false; // 幂等去重
    fs.mkdirSync(this.threadsDir, { recursive: true });
    const thread: FrozenThread = {
      id: input.threadId,
      ...(input.topic ? { topic: input.topic } : {}),
      turns: [
        { role: 'user' as const, content: input.userText, ...(input.signal ? { signal: input.signal } : {}) },
        ...(input.agentText ? [{ role: 'agent' as const, content: input.agentText }] : []),
      ],
    };
    fs.writeFileSync(file, JSON.stringify(thread, null, 2), 'utf-8');
    return true;
  }

  /** 单线程文件路径：<threadsDir>/<safeId>.json */
  private fileFor(threadId: string): string {
    const safe = threadId.replace(/[^\w-]/g, '_');
    return path.join(this.threadsDir, `${safe}.json`);
  }
}

/**
 * 从用户一轮输入 + 产出构建稳定 threadId。
 * 同一 learner + topic + 日期 收敛到同一 id（天然幂等，重复请求不重复建档）。
 */
export function buildThreadId(learnerId: string, topicId: string | undefined, when: Date = new Date()): string {
  const day = when.toISOString().slice(0, 10).replace(/-/g, '');
  return `t-${learnerId}-${safeToken(topicId)}-${day}`;
}

function safeToken(v?: string): string {
  if (!v) return 'general';
  return v.replace(/[^\w-]/g, '_').slice(0, 40);
}