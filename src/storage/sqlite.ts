import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { LearnerProfile } from '../engines/profile.js';
import type { ReflectionReport } from '../engines/reflection.js';
import type { AnswerSignal } from '../providers/index.js';
import type {
  StudyPlan,
  StudyReview,
  AnchorAdjustment,
  AnchorSnapshot,
  LearningEvent,
} from '../engines/plans/types.js';

/** 一轮对话记录（BUG-004） */
export interface ConversationTurn {
  learnerId: string;
  /** 未指定主题时省略；落库统一归一为空串 */
  topicId?: string;
  userText: string;
  agentText?: string;
  /** 本轮判定出的回答信号（供后续轮次做连续判定） */
  signal?: AnswerSignal;
  createdAt: string;
}

/** 主题归一：null/undefined/空串 → ''（避免 SQLite UNIQUE 对 NULL 不约束的坑） */
function normalizeTopicKey(topicId?: string): string {
  const t = (topicId ?? '').trim();
  return t === 'default' ? '' : t;
}

/**
 * 会话 id：learnerId + 归一主题。使用 JSON 数组编码避免分隔符冲突
 * （主题名本身可能含 ':'、'|'、空白等）。
 */
function conversationId(learnerId: string, topicKey: string): string {
  return JSON.stringify([learnerId, topicKey]);
}

/**
 * 轻量持久化存储（IT3，SQLite）。
 * 当前仅保存学习画像（按 learnerId 一行 JSON）；后续 IT4 反思报告等可在此扩展。
 * 约束：所有持久化读写走本层，禁止在引擎中散落写文件。
 */
export class SqliteStorage {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    // 确保目录存在
    const dir = path.dirname(dbPath);
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        learner_id TEXT PRIMARY KEY,
        data       TEXT NOT NULL,          -- LearnerProfile JSON
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reflections (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,          -- ReflectionReport JSON
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS study_plans (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,          -- StudyPlan JSON
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,          -- StudyReview JSON
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor_adjustments (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,          -- AnchorAdjustment JSON
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_events (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,          -- LearningEvent JSON
        updated_at TEXT NOT NULL
      );
      -- BUG-004：会话与逐轮消息（此前对话历史从未落库，history 恒为空）
      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        topic_id   TEXT NOT NULL DEFAULT '',   -- '' 表示未指定主题（SQLite UNIQUE 不约束 NULL，故用空串）
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_turns (
        conversation_id TEXT NOT NULL,
        turn_index      INTEGER NOT NULL,      -- 自 0 递增，稳定排序依据
        learner_id      TEXT NOT NULL,
        topic_id        TEXT NOT NULL DEFAULT '',
        user_text       TEXT NOT NULL,
        agent_text      TEXT NOT NULL DEFAULT '',
        signal          TEXT,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (conversation_id, turn_index)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns (conversation_id, turn_index);
    `);
  }

  getProfile(learnerId: string): LearnerProfile | null {
    const row = this.db
      .prepare('SELECT data FROM profiles WHERE learner_id = ?')
      .get(learnerId) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as LearnerProfile;
    } catch {
      return null;
    }
  }

  saveProfile(learnerId: string, profile: LearnerProfile): void {
    this.db
      .prepare(
        'INSERT INTO profiles (learner_id, data, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(learner_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      )
      .run(learnerId, JSON.stringify(profile), profile.updatedAt);
  }

  getReflection(id: string): ReflectionReport | null {
    const row = this.db
      .prepare('SELECT data FROM reflections WHERE id = ?')
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as ReflectionReport;
    } catch {
      return null;
    }
  }

  listReflections(): ReflectionReport[] {
    const rows = this.db.prepare('SELECT data FROM reflections ORDER BY updated_at DESC').all() as {
      data: string;
    }[];
    const out: ReflectionReport[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.data) as ReflectionReport);
      } catch {
        /* 跳过坏数据 */
      }
    }
    return out;
  }

  saveReflection(id: string, report: ReflectionReport): void {
    this.db
      .prepare(
        'INSERT INTO reflections (id, data, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      )
      .run(id, JSON.stringify(report), report.date);
  }

  /** 把反思报告导出为 markdown 落盘（data/reflections/<id>.md） */
  exportReflectionMarkdown(report: ReflectionReport, dir: string): string {
    const lines = [
      `# 每周反思升级（${report.date}）`,
      '',
      `- 触发：${report.trigger} · 状态：${report.status} · ID：${report.id}`,
      '',
      '## 观察点',
      ...report.observations.map((o) => `- ${o}`),
      '',
      '## 建议改进',
      ...report.improvements.map((o) => `- ${o}`),
      '',
      '## 新增功能需求',
      ...report.newFeatureRequests.map((o) => `- ${o}`),
      '',
      '## 新增资料',
      ...report.resourceAdditions.map((o) => `- ${o}`),
      '',
      ...(report.skillDrafts && report.skillDrafts.length > 0
        ? [
            '## 能力 skill 草案（§8.2.1）',
            ...report.skillDrafts.map(
              (d) => `- ${d.id}（${d.engine}，v${d.version}，策略 ${d.strategy}${d.sourceFile ? `，来源 ${d.sourceFile}` : ''}）`,
            ),
            '',
          ]
        : []),
    ];
    const mdDir = path.join(dir, 'reflections');
    fs.mkdirSync(mdDir, { recursive: true });
    const file = path.join(mdDir, `${report.id}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    return file;
  }

  /** 把学习计划导出为 markdown 落盘（data/plans/<id>.md） */
  exportPlanMarkdown(plan: StudyPlan, dir: string): string {
    const goals = plan.goals
      .map((g) => `- ${g.topicId}：目标掌握度 ${g.targetLevel.toFixed(2)}，目标深度 ${g.targetDepth}，计划 ${g.sessions} 次`)
      .join('\n');
    const lines = [
      `# 学习计划（${plan.period.start} ~ ${plan.period.end}）`,
      '',
      `- 学员：${plan.learnerId} · 状态：${plan.status} · ID：${plan.id}`,
      `- 生成策略：${plan.strategy}${plan.generatorVersion ? `（${plan.generatorVersion}）` : ''}`,
      '',
      '## 画像锚点',
      `- 初始掌握度：${JSON.stringify(plan.anchors.initialMastery)}`,
      `- 目标深度：${plan.anchors.targetDepth} · 目标难度：${plan.anchors.targetDifficulty.toFixed(2)} · 学习速度基线：${plan.anchors.learningSpeedBaseline.toFixed(2)} · 重复偏向：${plan.anchors.repetitionBias}`,
      '',
      '## 目标',
      goals,
      '',
    ];
    const mdDir = path.join(dir, 'plans');
    fs.mkdirSync(mdDir, { recursive: true });
    const file = path.join(mdDir, `${plan.id}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    return file;
  }

  /** 把复盘导出为 markdown 落盘（data/reviews/<id>.md） */
  exportReviewMarkdown(review: StudyReview, dir: string): string {
    const lines = [
      `# 学习复盘（${review.period.start} ~ ${review.period.end}）`,
      '',
      `- 学员：${review.learnerId} · 计划：${review.planId} · 状态：${review.status} · ID：${review.id}`,
      '',
      '## 加权评分',
      `- 综合：${review.scores.weighted.toFixed(3)}`,
      `- 目标完成率：${review.scores.goalCompletion.toFixed(3)}`,
      `- 信号正确率：${review.scores.signalAccuracy.toFixed(3)}`,
      `- 频率达成率：${review.scores.frequencyRate.toFixed(3)}`,
      `- 掌握度变化：${review.scores.masteryChange.toFixed(3)}`,
      '',
      '## 复盘发现',
      ...review.findings.map((f) => `- ${f}`),
      '',
      '## 后续建议',
      ...review.improvementNotes.map((f) => `- ${f}`),
      '',
    ];
    const mdDir = path.join(dir, 'reviews');
    fs.mkdirSync(mdDir, { recursive: true });
    const file = path.join(mdDir, `${review.id}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    return file;
  }

  /** 把锚定调整审计导出为 markdown 落盘（data/anchors/<reviewId>.md） */
  exportAnchorMarkdown(a: AnchorAdjustment, dir: string): string {
    const fmt = (s: AnchorSnapshot) =>
      [
        `- 初始掌握度：${JSON.stringify(s.initialMastery)}`,
        `- 目标深度：${s.targetDepth} · 目标难度：${s.targetDifficulty.toFixed(2)} · 学习速度基线：${s.learningSpeedBaseline.toFixed(2)} · 重复偏向：${s.repetitionBias}`,
      ].join('\n');
    const lines = [
      `# 锚定反思与修正（${a.reviewId}）`,
      '',
      `- 学员：${a.learnerId} · 触发：连续 ${a.trigger.streak} 次加权分 < ${a.trigger.threshold} · 方法：${a.method}`,
      `- 时间：${a.createdAt}`,
      '',
      '## 修正前锚点',
      fmt(a.before),
      '',
      '## 修正后锚点',
      fmt(a.after),
      '',
      '## 修正原因',
      ...a.reasons.map((r) => `- ${r}`),
      '',
    ];
    const mdDir = path.join(dir, 'anchors');
    fs.mkdirSync(mdDir, { recursive: true });
    const file = path.join(mdDir, `${a.reviewId}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    return file;
  }

  // ---- 学习计划 ----
  getStudyPlan(id: string): StudyPlan | null {
    return this.getJson('study_plans', id) as StudyPlan | null;
  }

  saveStudyPlan(id: string, plan: StudyPlan): void {
    this.saveJson('study_plans', id, plan, plan.updatedAt);
  }

  listStudyPlans(): StudyPlan[] {
    return this.listJson('study_plans') as StudyPlan[];
  }

  // ---- 复盘 ----
  getReview(id: string): StudyReview | null {
    return this.getJson('reviews', id) as StudyReview | null;
  }

  saveReview(id: string, review: StudyReview): void {
    this.saveJson('reviews', id, review, review.updatedAt);
  }

  listReviews(): StudyReview[] {
    return this.listJson('reviews') as StudyReview[];
  }

  // ---- 锚定审计 ----
  saveAnchorAdjustment(a: AnchorAdjustment): void {
    this.saveJson('anchor_adjustments', a.id, a, a.createdAt);
  }

  listAnchorAdjustments(): AnchorAdjustment[] {
    return this.listJson('anchor_adjustments') as AnchorAdjustment[];
  }

  // ---- 学习事件（按信号记录，供复盘评分） ----
  appendLearningEvent(ev: LearningEvent): void {
    this.saveJson('learning_events', ev.id, ev, ev.date);
  }

  listLearningEvents(learnerId: string): LearningEvent[] {
    return (this.listJson('learning_events') as LearningEvent[]).filter((e) => e.learnerId === learnerId);
  }

  // ---- 会话与逐轮消息（BUG-004：为「连续信号」判定提供真实 history） ----

  /**
   * 追加一轮对话（幂等按 (learner, topic) 定位会话，不存在则创建）。
   * 会话按 learnerId + topicId 归并：同一主题的连续对话属于同一会话。
   * @returns 本轮在会话内的自增序号
   */
  appendConversationTurn(turn: ConversationTurn): number {
    const topicKey = normalizeTopicKey(turn.topicId);
    const convId = conversationId(turn.learnerId, topicKey);
    const now = turn.createdAt;
    this.db
      .prepare(
        'INSERT INTO conversations (id, learner_id, topic_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
      )
      .run(convId, turn.learnerId, topicKey, now, now);

    const row = this.db
      .prepare('SELECT COALESCE(MAX(turn_index), -1) AS last FROM conversation_turns WHERE conversation_id = ?')
      .get(convId) as { last: number } | undefined;
    const index = (row?.last ?? -1) + 1;

    this.db
      .prepare(
        'INSERT INTO conversation_turns ' +
          '(conversation_id, turn_index, learner_id, topic_id, user_text, agent_text, signal, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        convId,
        index,
        turn.learnerId,
        topicKey,
        turn.userText,
        turn.agentText ?? '',
        turn.signal ?? null,
        now,
      );
    return index;
  }

  /**
   * 读取**当前轮之前**的信号历史（旧→新），供「连续 2 次 confused → hint」判定。
   * 必须在 appendConversationTurn 之前调用，否则当前轮会被计入。
   */
  listRecentSignals(learnerId: string, topicId?: string, limit = 20): AnswerSignal[] {
    const rows = this.db
      .prepare(
        'SELECT signal FROM conversation_turns WHERE conversation_id = ? AND signal IS NOT NULL ' +
          'ORDER BY turn_index DESC LIMIT ?',
      )
      .all(conversationId(learnerId, normalizeTopicKey(topicId)), limit) as { signal: string }[];
    // DESC 取最近 limit 条，再反转为旧→新（latestConsecutive 依赖此顺序）
    return rows.reverse().map((r) => r.signal as AnswerSignal);
  }

  /** 读取某会话全部逐轮消息（旧→新，供回放/调试/会话恢复） */
  listConversationTurns(learnerId: string, topicId?: string): ConversationTurn[] {
    const rows = this.db
      .prepare(
        'SELECT turn_index, learner_id, topic_id, user_text, agent_text, signal, created_at ' +
          'FROM conversation_turns WHERE conversation_id = ? ORDER BY turn_index ASC',
      )
      .all(conversationId(learnerId, normalizeTopicKey(topicId))) as {
      learner_id: string;
      topic_id: string;
      user_text: string;
      agent_text: string;
      signal: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      learnerId: r.learner_id,
      topicId: r.topic_id || undefined,
      userText: r.user_text,
      agentText: r.agent_text,
      signal: (r.signal ?? undefined) as AnswerSignal | undefined,
      createdAt: r.created_at,
    }));
  }

  /** 通用 JSON 读取（id → data 列，坏数据返回 null） */
  private getJson(table: string, id: string): unknown | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as unknown;
    } catch {
      return null;
    }
  }

  /** 通用 JSON 写入（幂等 upsert） */
  private saveJson(table: string, id: string, data: unknown, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, ?) ` +
          `ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(data), updatedAt);
  }

  /** 通用 JSON 列表（updated_at 降序，跳过坏数据） */
  private listJson(table: string): unknown[] {
    const rows = this.db.prepare(`SELECT data FROM ${table} ORDER BY updated_at DESC`).all() as {
      data: string;
    }[];
    const out: unknown[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.data) as unknown);
      } catch {
        /* 跳过坏数据 */
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }

  isClosed(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return false;
    } catch {
      return true;
    }
  }
}