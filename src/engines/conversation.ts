import type { AnswerSignal } from '../providers/index.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import type { ProfileEngine } from './profile.js';
import type { SocraticEngine, TeachingAction } from './socratic.js';
import { SignalParser } from './signal.js';
import type { LearningEvent } from './plans/types.js';

/**
 * 一轮苏格拉底对话的编排（BUG-004 修复的共享实现）。
 *
 * 此前 `/api/chat`、`/api/voice/chat`、MCP `chat_socratic` **各自复制**同一段 4 步流水线，
 * 且三处都把 `history` 硬编码为 `[]`，导致 `socratic.core` 的连续信号判定
 * （`latestConsecutive`）与 `when.ts` 的 `consecutiveHit` 在真实服务里永不命中。
 *
 * 现收敛为单一实现，并显式落库会话、读取**当前轮之前**的真实信号历史。
 * 顺序敏感：必须**先读历史**（不含本轮）→ 解析信号 → 更新画像 → 生成动作 → 落库本轮。
 * 若先落库再读，当前轮会被计入历史，导致连续次数多算一次。
 */

/** 构造依赖（`/api/chat` 与 `/api/voice/chat` 共用同一批实例） */
export interface ConversationDeps {
  store: SqliteStorage;
  parser: SignalParser;
  profile: ProfileEngine;
  socratic: SocraticEngine;
  /** 参与连续判定的历史轮数上限（默认 20） */
  maxHistory?: number;
}

export interface RecordTurnInput {
  learnerId: string;
  topicId?: string;
  userText: string;
}

export interface RecordTurnResult {
  signal: AnswerSignal;
  action: TeachingAction;
}

const DEFAULT_MAX_HISTORY = 20;

/** 学习事件 id（`ev-<时间戳>-<随机>`，与原三处实现保持一致） */
export function nextEventId(now = Date.now()): string {
  return `ev-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 执行一轮对话：读历史 → 解析信号 → 更新画像 → 记录学习事件 → 生成教学动作 → 落库本轮。
 * 抛错时不落库（调用方按各自 API 契约处理错误）。
 */
export async function recordTurn(
  deps: ConversationDeps,
  input: RecordTurnInput,
): Promise<RecordTurnResult> {
  const { store, parser, profile, socratic } = deps;
  const topicId = input.topicId;

  // 1) 先读**本轮之前**的信号历史（旧→新），供连续判定
  const history = store.listRecentSignals(
    input.learnerId,
    topicId,
    deps.maxHistory ?? DEFAULT_MAX_HISTORY,
  );

  // 2) 解析本轮信号
  const parsed = await parser.parse({ answer: input.userText, concept: topicId });

  // 3) 更新画像（保持既有 await 语义）
  await profile.updateFromSignal(input.learnerId, parsed.signal, topicId);

  // 4) 记录学习事件（复盘加权评分的输入源）
  const createdAt = new Date().toISOString();
  const event: LearningEvent = {
    id: nextEventId(),
    learnerId: input.learnerId,
    topicId,
    signal: parsed.signal,
    date: createdAt,
  };
  store.appendLearningEvent(event);

  // 5) 生成教学动作（注入真实 history，修复死代码）
  const action = await socratic.generateAction({
    answer: input.userText,
    concept: topicId,
    signal: parsed,
    profile: profile.toAdaptiveView(input.learnerId, topicId),
    history,
  });

  // 6) 落库本轮（放在动作生成之后：本轮 signal 不应出现在自己的 history 里）
  store.appendConversationTurn({
    learnerId: input.learnerId,
    topicId,
    userText: input.userText,
    agentText: actionText(action),
    signal: parsed.signal,
    createdAt,
  });

  return { signal: parsed.signal, action };
}

/** 从教学动作中取可播报/可落库的文本（recommend 无 content 时给出占位说明） */
export function actionText(action: TeachingAction): string {
  if ('content' in action) return action.content ?? '';
  if (action.type === 'recommend') return `为你推荐了 ${action.resourceIds.length} 个资料`;
  return '';
}
