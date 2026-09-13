import type { LLMProvider } from '../providers/index.js';
import type { ReminderProvider } from '../providers/index.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import { scanKnowledgeDirForSkills, type SkillDraftMeta, type SkillEngine } from './skillgen/index.js';
import path from 'node:path';

/** 反思报告状态（详见 detail.md 1.3） */
export type ReflectionStatus = 'draft' | 'confirmed' | 'designed' | 'planned' | 'done';

/** 反思报告（数据模型，详见 detail.md 1.3） */
export interface ReflectionReport {
  id: string;
  date: string; // ISO8601
  trigger: 'manual' | 'weekly';
  observations: string[];
  improvements: string[];
  newFeatureRequests: string[];
  resourceAdditions: string[];
  status: ReflectionStatus;
  /** §8.2.1：本次反思从方法论类知识 md 生成的能力 skill 草案（可空） */
  skillDrafts?: SkillDraftMeta[];
}

/** structuredCall 返回的原始报告字段 */
interface RawReflection {
  observations: string[];
  improvements: string[];
  new_feature_requests?: string[];
  resource_additions?: string[];
}

const SYSTEM_PROMPT = `你是每周自我审视助教（"吾日三省吾身"）。请基于近期对话与资料，汇总一份升级建议。
只输出 JSON 对象，字段：
- observations: string[]，观察到的学习/对话/使用情况要点
- improvements: string[]，对教学引擎、学习画像或自适应的改进建议
- new_feature_requests: string[]（可空）
- resource_additions: string[]（可空）新增建议纳入的资料
只输出 JSON，不要输出其他文字。`;

export interface ReflectionEngineOptions {
  /** 反思报告 markdown 落盘目录（通常为 data） */
  outputDir: string;
  /** 手动触发时的参考上下文（可选，用于补充 LLM 输入） */
  contextHint?: string;
  /** §8.2.1 能力 skill 生成：扫描知识目录生成草案（可选，见 skillGen 说明） */
  skillGen?: {
    /** 扫描的知识 md 目录（默认 knowledge/skills） */
    knowledgeDir?: string;
    /** 生成的目标引擎（socratic | profile） */
    engine?: SkillEngine;
    /** 提炼/判定的 LLM（可缺省 → 启发式降级） */
    llm?: LLMProvider;
    /** 是否写盘 TS 源码与说明文档（默认 false：仅生成草案不落盘） */
    write?: boolean;
  };
}

/**
 * 每周反思闭环引擎（IT4，详见 detail.md 5.3）。
 * 流程：触发(manual/cron) → 收集 → LLM 汇总 draft → 持久化+导出 md → 提醒 → 用户 confirm。
 * 未 confirm 不进入设计与开发（状态停留在 draft）。
 */
export class ReflectionEngine {
  constructor(private llm: LLMProvider, private store: SqliteStorage) {}

  /**
   * 运行一次反思，生成 draft 报告并返回文件路径。
   * 同一日期已存在 draft 时幂等复用（同批不重复生成）。
   */
  async run(
    trigger: 'manual' | 'weekly',
    opts?: ReflectionEngineOptions,
    remind?: ReminderProvider,
  ): Promise<{ report: ReflectionReport; markdownPath: string }> {
    const id = buildId(new Date(), trigger);
    const existing = this.store.getReflection(id);
    if (existing) {
      if (existing.status === 'draft') {
        // 幂等：已有同批 draft，不再重新生成
        const md = this.store.exportReflectionMarkdown(existing, opts?.outputDir ?? '.');
        return { report: existing, markdownPath: md };
      }
      // 已确认过：直接复用当前报告
      return { report: existing, markdownPath: this.store.exportReflectionMarkdown(existing, opts?.outputDir ?? '.') };
    }

    // 1) LLM 汇总
    const res = await this.llm.structuredCall<RawReflection>(SYSTEM_PROMPT, buildUserPrompt(opts), {
      type: 'object',
      properties: {
        observations: { type: 'array', items: { type: 'string' } },
        improvements: { type: 'array', items: { type: 'string' } },
        new_feature_requests: { type: 'array', items: { type: 'string' } },
        resource_additions: { type: 'array', items: { type: 'string' } },
      },
      required: ['observations', 'improvements'],
    });

    const report: ReflectionReport = res.ok
      ? {
          id,
          date: new Date().toISOString(),
          trigger,
          observations: res.data.observations ?? [],
          improvements: res.data.improvements ?? [],
          newFeatureRequests: res.data.new_feature_requests ?? [],
          resourceAdditions: res.data.resource_additions ?? [],
          status: 'draft',
        }
      : // LLM 失败降级：生成空 draft，仍可确认流程
        {
          id,
          date: new Date().toISOString(),
          trigger,
          observations: ['反思生成失败：模型暂时不可用，需稍后重试。'],
          improvements: [],
          newFeatureRequests: [],
          resourceAdditions: [],
          status: 'draft',
        };

    // 1.5) §8.2.1：扫描方法论类知识 md，生成能力 skill 草案（可选；不写盘不改引擎，仅记录）
    if (opts?.skillGen) {
      report.skillDrafts = await scanKnowledgeDirForSkills({
        dir: opts.skillGen.knowledgeDir ?? path.resolve('knowledge/skills'),
        engine: opts.skillGen.engine ?? 'socratic',
        llm: opts.skillGen.llm,
        write: opts.skillGen.write ?? false,
      });
    }

    // 2) 持久化 + 导出 md
    this.store.saveReflection(id, report);
    const markdownPath = this.store.exportReflectionMarkdown(report, opts?.outputDir ?? '.');

    // 3) Web 提醒
    if (remind) {
      await remind.notify('存在待审阅的升级需求文档', `反思报告 ${id} 已生成，请到反思/升级页确认或修改。`);
    }

    return { report, markdownPath };
  }

  /** 用户确认：draft → confirmed。未确认期间不会推进开发。 */
  confirm(id: string): ReflectionReport {
    const report = this.store.getReflection(id);
    if (!report) throw new Error(`反思报告不存在: ${id}`);
    if (report.status !== 'draft') throw new Error(`仅 draft 状态可确认，当前为 ${report.status}`);
    report.status = 'confirmed';
    this.store.saveReflection(id, report);
    return report;
  }

  /** 最新报告（草稿优先）；无则 null */
  latest(): ReflectionReport | null {
    return this.store.listReflections()[0] ?? null;
  }
}

function buildId(date: Date, trigger: 'manual' | 'weekly'): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}-${trigger}`;
}

function buildUserPrompt(opts?: ReflectionEngineOptions): string {
  const hint = opts?.contextHint ? `\n可参考的背景：${opts.contextHint}` : '';
  return `请基于近期学习对话与资料做一次反思审查。${hint}\n给出本周的观察点与改进建议。`;
}