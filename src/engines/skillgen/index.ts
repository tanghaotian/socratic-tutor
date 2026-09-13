import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider, AnswerSignal } from '../../providers/index.js';
import type {
  CapabilitySkill,
  SkillContext,
  SkillResult,
  SkillMeta,
  SkillEngine,
  SkillWhen,
  ActiveSkill,
} from '../skills/types.js';
import { evaluateWhen, canHandleFor } from '../skills/when.js';
import type { FrozenThread, EvalReport, Verdict } from '../eval/types.js';
import { runEvalGate, registerSkillFactory } from '../eval/reflection-gate.js';
import {
  StrategyManager,
  createSocraticManager,
  createProfileManager,
} from '../skills/index.js';

/**
 * §8.2.1 能力 skill 生成链路（知识产物 → 能力策略 skill，Phase 1.5）。
 *
 * 流程（detail.md §8.2.1）：
 *   book-to-skill 知识 md(knowledge/skills/) 
 *     → classifyMethodology 判定是否教学/教育方法论类
 *     → 是：由 LLM 提炼规则(extractRules)，失败降级关键字启发式
 *     → buildSkillCode 生成纯 TS CapabilitySkill 草案 + 说明文档
 *     → createSkillFromRules 运行时等价实现 + registerGeneratedSkill 注册工厂
 *     → 后可经 runEvalGate 评测门禁 + 人工拦截 → enable 到 StrategyManager
 *
 * 产物仍是纯 TS CapabilitySkill（§8.1 形态一致），仅来源升级为知识 md 提炼。
 * 生成 skill 的 apply 为确定性规则实现（叠加改写/画像增量），不依赖 LLM，可离线测试。
 */

export interface MethodologyDecision {
  isMethodology: boolean;
  confidence: number; // 0-1
  reason: string;
  /** 是否 LLM 判定（false 表示启发式降级） */
  llmJudged: boolean;
}

/** 提炼出的规则：决定生成 skill 的确定性行为（内联进 TS 源码） */
export interface SkillRules {
  id: string;
  engine: SkillEngine;
  version: string;
  purpose: string;
  /** 策略类型标记：motivation | adaptivity | ...（描述用） */
  strategy: string;
  /** 命中 input 关键字才叠加；空数组 = 始终叠加 */
  triggers: string[];
  /** 叠加引导语模板，{topic} 会被替换为用户输入片段；空 = 不叠加文案 */
  phrase: string;
  /** profile 引擎的兴趣增量值 */
  interestBoost: number;
  /** when-to-use 触发条件（可选，缺省=始终适用，兼容旧叠加） */
  when?: SkillWhen;
}

export interface SkillDraft {
  rules: SkillRules;
  /** 生成的 TS 源码 */
  code: string;
  /** 源知识 md（来源溯源） */
  sourceFile?: string;
  /** 生成源码落盘路径 */
  srcPath?: string;
  /** 说明文档落盘路径 */
  docPath?: string;
}

/** 反思报告里记录 skill 草案的元信息（轻量，不携带完整源码） */
export interface SkillDraftMeta {
  id: string;
  engine: SkillEngine;
  version: string;
  strategy: string;
  sourceFile?: string;
  srcPath?: string;
  docPath?: string;
  /** 若已跑评测门禁，记录 verdict */
  evalVerdict?: Verdict;
}

export interface SkillGenOptions {
  /** 是否写盘（默认 true） */
  write?: boolean;
  /** 生成 skill 源码目录（默认 src/engines/skills/generated） */
  srcDir?: string;
  /** 说明文档目录（默认 docs/skills） */
  docDir?: string;
  /** 额外规则覆盖（id/version 若缺省由 generateFromKnowledge 填充） */
  rules?: Partial<SkillRules>;
}

const METHODOLOGY_KEYWORDS = [
  '教学', '教育', '启发', '提问', '苏格拉底', '引导', '激励', '反馈',
  '自适应', '讲授方法', '学习方法', '技巧', '策略', '认知', '思维', 'pedagogy', 'mentor', 'tutor', 'coaching',
];

const JUDGE_METHOD_SYSTEM = `你是教学研究方法论分类器。给定一份知识资料（可能来自书籍/论文/视频摘要），判定其内容是否属于"教学/教育方法论"类——即包含可复用的教学启发、提问技巧、激励方法或自适应调整策略，可作为能力策略 skill 的来源。只输出 JSON：{ isMethodology: boolean, confidence: 0-1, reason: string }。只输出 JSON。`;

const EXTRACT_SYSTEM = `你是能力策略 skill 提炼器。将给定的教学方法论资料提炼为一份可用规则，并把该策略的适用场景提炼为 when（when-to-use）：
- purpose: 一句话说明该 skill 的作用
- strategy: 策略类型（motivation | adaptivity | feedback | interest 等，自定）
- triggers: 用户回答中命中即叠加该策略的关键词/短语数组（可空）
- phrase: 叠加在教学动作前的引导语模板，用 {topic} 占位"用户提及的话题"；空串表示不叠加文案
- interestBoost: 0-10 的兴趣权重增量（profile 引擎用）
- when: 该策略何时/何场景才应被引用（可空=始终适用）。字段：
  - concepts: 命中的概念/主题关键词数组（命中用户回答或当前概念即适用）；可空
  - signals: 适用时的回答信号数组（correct/confused/mistake/divergent）；可空
  - consecutive: { signal, count } 最近需连续 count 次为该信号才适用；可空
  - profileMasteryLt: 画像掌握度低于该阈值才适用（0-1）；可空
  - exclusiveGroup: 互斥组 id（与该用途的其他 skill 竞合时仅一个启用）；可空
  - priority: 组合权重基值 0-10（同组竞合打分基值）；可空
只输出 JSON：{ purpose: string, strategy: string, triggers: string[], phrase: string, interestBoost: number, when?: { concepts?: string[], signals?: string[], consecutive?: { signal: string, count: number }, profileMasteryLt?: number, exclusiveGroup?: string, priority?: number } }。只输出 JSON。`;

interface RawWhen {
  concepts?: string[];
  signals?: string[];
  consecutive?: { signal?: string; count?: number };
  profileMasteryLt?: number;
  exclusiveGroup?: string;
  priority?: number;
}

interface RawExtract {
  purpose?: string;
  strategy?: string;
  triggers?: string[];
  phrase?: string;
  interestBoost?: number;
  when?: RawWhen;
}

interface RawMethod {
  isMethodology?: boolean;
  confidence?: number;
  reason?: string;
}

/**
 * 判定资料是否为教学/教育方法论类。
 * 有 LLM 用 structuredCall；无 LLM 或失败降级为关键字启发式（llmJudged=false）。
 */
export async function classifyMethodology(
  content: string,
  llm?: LLMProvider,
  opts: { sourceFile?: string } = {},
): Promise<MethodologyDecision> {
  const trimmed = content.slice(0, 12000);
  if (llm) {
    try {
      const res = await llm.structuredCall<RawMethod>(
        JUDGE_METHOD_SYSTEM,
        `资料来源：${opts.sourceFile ?? '未知'}\n\n资料内容：\n${trimmed}`,
        {
          type: 'object',
          properties: {
            isMethodology: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
          },
          required: ['isMethodology', 'confidence', 'reason'],
        },
      );
      if (res.ok && typeof res.data.isMethodology === 'boolean') {
        return {
          isMethodology: res.data.isMethodology,
          confidence: clamp01(res.data.confidence ?? 0.5),
          reason: res.data.reason ?? '(LLM 未给出理由)',
          llmJudged: true,
        };
      }
    } catch {
      /* 落到启发式 */
    }
  }
  const hits = METHODOLOGY_KEYWORDS.filter((k) => trimmed.includes(k));
  const isMethodology = hits.length >= 2;
  return {
    isMethodology,
    confidence: isMethodology ? clamp01(0.5 + hits.length * 0.05) : 0.3,
    reason: `关键字启发式（命中 ${hits.slice(0, 5).join('、') || '无'}）`,
    llmJudged: false,
  };
}

/**
 * 由知识内容提炼 skill 规则。LLM structuredCall 提取，失败降级为通用默认规则。
 * id/engine/version 由 generateFromKnowledge 传入填充，这里只提炼行为规则。
 */
export async function extractRules(
  content: string,
  llm?: LLMProvider,
): Promise<Omit<SkillRules, 'id' | 'engine' | 'version'>> {
  const trimmed = content.slice(0, 12000);
  if (llm) {
    try {
      const res = await llm.structuredCall<RawExtract>(
        EXTRACT_SYSTEM,
        `资料内容：\n${trimmed}`,
        {
          type: 'object',
          properties: {
            purpose: { type: 'string' },
            strategy: { type: 'string' },
            triggers: { type: 'array', items: { type: 'string' } },
            phrase: { type: 'string' },
            interestBoost: { type: 'number', minimum: 0, maximum: 10 },
            when: {
              type: 'object',
              properties: {
                concepts: { type: 'array', items: { type: 'string' } },
                signals: { type: 'array', items: { type: 'string' } },
                consecutive: { type: 'object', properties: { signal: { type: 'string' }, count: { type: 'number' } } },
                profileMasteryLt: { type: 'number', minimum: 0, maximum: 1 },
                exclusiveGroup: { type: 'string' },
                priority: { type: 'number', minimum: 0, maximum: 10 },
              },
            },
          },
          required: ['purpose', 'strategy', 'triggers', 'phrase', 'interestBoost'],
        },
      );
      if (res.ok && res.data.purpose) {
        return {
          purpose: res.data.purpose,
          strategy: res.data.strategy ?? 'motivation',
          triggers: (res.data.triggers ?? []).filter(Boolean),
          phrase: res.data.phrase ?? '',
          interestBoost: clamp01((res.data.interestBoost ?? 1) / 10) * 10,
          when: normalizeWhen(res.data.when),
        };
      }
    } catch {
      /* 落到默认规则 */
    }
  }
  // 降级：通用激励引导，始终叠加（when 由 triggers 派生为 concepts 命中）
  return {
    purpose: '由教学方法论资料提炼的通用激励引导（启发式降级）',
    strategy: 'motivation',
    triggers: [],
    phrase: '继续说说你的理解，{topic} 这块再往前推一步就通了。',
    interestBoost: 2,
  };
}

const VALID_SIGNALS: AnswerSignal[] = ['correct', 'confused', 'mistake', 'divergent'];

/** 归一化 LLM/调用方传入的 when，过滤非法字段与信号值 */
function normalizeWhen(raw?: RawWhen | SkillWhen): SkillWhen | undefined {
  if (!raw) return undefined;
  const out: SkillWhen = {};
  if (Array.isArray(raw.concepts)) out.concepts = (raw.concepts as string[]).filter(Boolean);
  if (Array.isArray(raw.signals)) {
    out.signals = (raw.signals as string[]).filter(
      (s): s is AnswerSignal => VALID_SIGNALS.includes(s as AnswerSignal),
    );
  }
  if (raw.consecutive && typeof raw.consecutive.count === 'number' && raw.consecutive.count >= 1) {
    const sig = raw.consecutive.signal;
    if (sig && VALID_SIGNALS.includes(sig as AnswerSignal)) {
      out.consecutive = { signal: sig as AnswerSignal, count: Math.floor(raw.consecutive.count) };
    }
  }
  if (typeof raw.profileMasteryLt === 'number') out.profileMasteryLt = clamp01(raw.profileMasteryLt);
  if (raw.exclusiveGroup) out.exclusiveGroup = raw.exclusiveGroup;
  if (typeof raw.priority === 'number') out.priority = Math.max(0, Math.min(10, Math.floor(raw.priority)));
  const has = Object.keys(out).length > 0;
  return has ? out : undefined;
}

/** 将非字母数字替换为下划线，得到合法 TS 标识符 */
function sanitizeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9]/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/** 由 id 派生 PascalCase（用于生成工厂函数名），如 'socratic.probe' → 'SocraticProbe' */
function pascalId(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** 运行时等价实现（与 generateSkillCode 生成码行为一致），供评测门禁重建 skill */
export function createSkillFromRules(rules: SkillRules): CapabilitySkill {
  const meta: SkillMeta = {
    id: rules.id,
    engine: rules.engine,
    version: rules.version,
    purpose: rules.purpose,
  };

  // when-to-use 触发/组合属性：仅当提炼出 when 时挂载，否则保持"始终适用"（兼容旧叠加）
  const gate =
    rules.when && Object.keys(rules.when).length > 0
      ? {
          when: (ctx: SkillContext) => evaluateWhen(rules.when, ctx),
          canHandle: (ctx: SkillContext) => canHandleFor(rules.when, ctx),
          exclusiveGroup: rules.when.exclusiveGroup,
        }
      : {};

  if (rules.engine === 'profile') {
    return {
      id: rules.id,
      engine: 'profile',
      version: rules.version,
      describe: () => meta,
      ...gate,
      apply(ctx: SkillContext): SkillResult {
        const topic = ctx.concept ?? 'general';
        return {
          engine: 'profile',
          delta: { interestDelta: { [topic]: rules.interestBoost } },
          meta,
        };
      },
    };
  }

  // socratic：叠加改写（参考 socratic.interest）
  return {
    id: rules.id,
    engine: 'socratic',
    version: rules.version,
    describe: () => meta,
    ...gate,
    apply(ctx: SkillContext): SkillResult {
      const prev = ctx.prevAction;
      if (!prev || !('content' in prev) || !rules.phrase) {
        return { engine: 'socratic', meta };
      }
      const hit = rules.triggers.length === 0 || rules.triggers.some((t) => ctx.input.includes(t));
      if (!hit) return { engine: 'socratic', meta };
      const topic = ctx.input.trim().slice(0, 24) || '这个话题';
      const content = rules.phrase.replaceAll('{topic}', topic).trim() + prev.content;
      return { engine: 'socratic', action: { ...prev, content }, meta };
    },
  };
}

/** 将 SkillWhen 序列化为内联 TS 对象字面量源码（空/未定义 → '{}'） */
function whenToSource(w: SkillWhen | undefined): string {
  if (!w) return '{}';
  const parts: string[] = [];
  if (w.concepts?.length) parts.push(`concepts: ${JSON.stringify(w.concepts)}`);
  if (w.signals?.length) parts.push(`signals: ${JSON.stringify(w.signals)}`);
  if (w.consecutive) parts.push(`consecutive: { signal: ${JSON.stringify(w.consecutive.signal)}, count: ${w.consecutive.count} }`);
  if (typeof w.profileMasteryLt === 'number') parts.push(`profileMasteryLt: ${w.profileMasteryLt}`);
  if (w.exclusiveGroup) parts.push(`exclusiveGroup: ${JSON.stringify(w.exclusiveGroup)}`);
  if (typeof w.priority === 'number') parts.push(`priority: ${w.priority}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

/** 人类可读描述 when（when-to-use）使用场景，供说明文档展示 */
function describeWhen(w: SkillWhen | undefined): string {
  if (!w || Object.keys(w).length === 0) return '（未声明，始终适用）';
  const rows: string[] = [];
  if (w.concepts?.length) rows.push(`- 概念/主题：${w.concepts.join('、')}`);
  if (w.signals?.length) rows.push(`- 回答信号：${w.signals.join('、')}`);
  if (w.consecutive) rows.push(`- 连续 ${w.consecutive.count} 次回答为「${w.consecutive.signal}」`);
  if (typeof w.profileMasteryLt === 'number') rows.push(`- 画像掌握度 < ${w.profileMasteryLt}`);
  if (w.exclusiveGroup) rows.push(`- 互斥组：${w.exclusiveGroup}（同组竞合时按 canHandle 择优）`);
  if (typeof w.priority === 'number') rows.push(`- 组合优先级基值：${w.priority}`);
  return rows.join('\n');
}

/** 生成纯 TS CapabilitySkill 源码（确定性规则，内联 rules + when） */
export function buildSkillCode(rules: SkillRules): string {
  const fn = `create${pascalId(rules.id)}Skill`;
  const triggers = rules.triggers.map((t) => JSON.stringify(t)).join(', ');
  const triggerArr = rules.triggers.length === 0 ? '[]' : `[${triggers}]`;
  const engine = rules.engine;
  const whenSrc = whenToSource(rules.when);
  const body = engineSnippet(engine, rules.phrase, triggerArr, rules.interestBoost);
  return `import { evaluateWhen, canHandleFor } from '../when.js';
import type { CapabilitySkill, SkillContext, SkillResult, SkillMeta, SkillWhen } from '../types.js';

/**
 * 由知识产物自动生成的能力策略 skill（§8.2.1）。
 * 来源：教学方法论资料提炼。确定性规则实现，不依赖 LLM。
 * when（when-to-use）：声明该 skill 在什么场景下才应被引用；同 exclusiveGroup 与其他 skill 竞合时由 canHandle 择优。
 */
const RULES = {
  id: '${rules.id}',
  version: '${rules.version}',
  purpose: '${rules.purpose}',
  strategy: '${rules.strategy}',
  triggers: ${triggerArr},
  phrase: '${rules.phrase}',
  interestBoost: ${rules.interestBoost},
  when: ${whenSrc} as SkillWhen,
};

const META: SkillMeta = { id: RULES.id, engine: '${engine}', version: RULES.version, purpose: RULES.purpose };

export function ${fn}(): CapabilitySkill {
  const gate = Object.keys(RULES.when).length > 0
    ? {
        when: (c: SkillContext) => evaluateWhen(RULES.when, c),
        canHandle: (c: SkillContext) => canHandleFor(RULES.when, c),
        exclusiveGroup: RULES.when.exclusiveGroup,
      }
    : {};
  return {
    id: RULES.id,
    engine: '${engine}',
    version: RULES.version,
    describe: () => META,
    ...gate,
    apply(ctx: SkillContext): SkillResult {
${body}
    },
  };
}
`;
}

/** 生成 apply 函数体（socratic/profile 分支，与 createSkillFromRules 语义一致） */
function engineSnippet(
  engine: SkillEngine,
  phrase: string,
  triggerArr: string,
  interestBoost: number,
): string {
  if (engine === 'profile') {
    return `      const topic = ctx.concept ?? 'general';
      return {
        engine: 'profile',
        delta: { interestDelta: { [topic]: RULES.interestBoost } },
        meta: META,
      };`;
  }
  const usesPhrase = Boolean(phrase);
  if (!usesPhrase) {
    return `      return { engine: 'socratic', meta: META };`;
  }
  return `      const prev = ctx.prevAction;
      if (!prev || !('content' in prev) || !RULES.phrase) {
        return { engine: 'socratic', meta: META };
      }
      const hit = RULES.triggers.length === 0 || RULES.triggers.some((t) => ctx.input.includes(t));
      if (!hit) return { engine: 'socratic', meta: META };
      const topic = ctx.input.trim().slice(0, 24) || '这个话题';
      const content = RULES.phrase.replaceAll('{topic}', topic).trim() + prev.content;
      return { engine: 'socratic', action: { ...prev, content }, meta: META };`;
}

/**
 * §8.2.1 链路编排：判定 → 提炼 → 生成草案 → 写盘（可选）。
 * 返回 SkillDraft；调用方可据此 registerGeneratedSkill + 运行 eval 门禁。
 */
export async function generateFromKnowledge(
  input: {
    content: string;
    engine: SkillEngine;
    id: string;
    sourceFile?: string;
    version?: string;
  },
  opts: SkillGenOptions = {},
  llm?: LLMProvider,
): Promise<SkillDraft> {
  const decision = await classifyMethodology(input.content, llm, { sourceFile: input.sourceFile });

  const base = await extractRules(input.content, llm);
  const rules: SkillRules = {
    id: input.id,
    engine: input.engine,
    version: input.version ?? '0.1.0',
    purpose: opts.rules?.purpose ?? base.purpose,
    strategy: opts.rules?.strategy ?? base.strategy,
    triggers: opts.rules?.triggers ?? base.triggers,
    phrase: opts.rules?.phrase ?? base.phrase,
    interestBoost: opts.rules?.interestBoost ?? base.interestBoost,
    when: opts.rules?.when ?? base.when,
  };

  const code = buildSkillCode(rules);
  const draft: SkillDraft = { rules, code: code.trim(), sourceFile: input.sourceFile };

  const write = opts.write !== false;
  if (write) {
    const srcDir = opts.srcDir ?? path.resolve('src/engines/skills/generated');
    const docDir = opts.docDir ?? path.resolve('docs/skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(docDir, { recursive: true });
    draft.srcPath = path.join(srcDir, `${rules.id}.ts`);
    fs.writeFileSync(draft.srcPath, code, 'utf-8');
    draft.docPath = path.join(docDir, `${rules.id}.md`);
    fs.writeFileSync(
      draft.docPath,
      [
        `# Skill: ${rules.id}`,
        '',
        `- 引擎：${rules.engine}`,
        `- 版本：${rules.version}`,
        `- 策略类型：${rules.strategy}`,
        `- 来源：${input.sourceFile ?? '（未指定）'}`,
        `- 判定为方法论类：${decision.isMethodology}（${decision.llmJudged ? 'LLM 判定' : '启发式'}，置信 ${decision.confidence}）`,
        '',
        `## 目的`,
        '',
        rules.purpose,
        '',
        `## 行为规则`,
        '',
        `- 触发词：${rules.triggers.length ? rules.triggers.join('、') : '（始终叠加）'}`,
        `- 引导语：${rules.phrase || '（不叠加文案）'}`,
        `- 兴趣增量：${rules.interestBoost}`,
        '',
        `## 使用场景（when-to-use）`,
        '',
        describeWhen(rules.when),
        '',
        `## 评测后应用`,
        '',
        `本 skill 为草案，需经评测回测门禁（runEvalGate）+ 人工拦截确认后，再 enable 到对应引擎的 StrategyManager。`,
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  return draft;
}

/**
 * 将规则注册到评测门禁的 skill 工厂表（registerSkillFactory），
 * 使 runEvalGate 可按快照 id 重建该生成 skill 进行回测。返回可重建的 CapabilitySkill。
 */
export function registerGeneratedSkill(rules: SkillRules): CapabilitySkill {
  const skill = createSkillFromRules(rules);
  registerSkillFactory(rules.id, () => createSkillFromRules(rules));
  return skill;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
}

export interface SkillGenPipelineOptions {
  content: string;
  engine: SkillEngine;
  id: string;
  sourceFile?: string;
  version?: string;
  /** 基线（旧版）激活 skill 组合，用于回测对照 */
  baselineSkills: ActiveSkill[];
  /** 冻结线程（评测重放源） */
  threads: FrozenThread[];
  /** 裁判模型（可缺省 → 降级启发式） */
  judgeProvider?: LLMProvider;
  /** 评测产物目录（默认 data/evals） */
  outputDir?: string;
  kind?: 'weekly' | 'monthly';
  /** 是否写盘生成 TS 源码与说明文档（默认 true） */
  write?: boolean;
  /** 生成 skill 源码目录（默认 src/engines/skills/generated） */
  srcDir?: string;
  /** 说明文档目录（默认 docs/skills） */
  docDir?: string;
}

export interface SkillGenPipelineResult {
  decision: MethodologyDecision;
  /** 非方法论类内容为 null（仅作 RAG 知识源，不生成 skill） */
  draft: SkillDraft | null;
  /** 已跑评测回测门禁时的报告 */
  evalReport?: EvalReport;
}

/**
 * §8.2.1 全链路编排（判定 → 提炼 → 生成草案 → 注册工厂 → 评测门禁）。
 * 内容判定为方法论类才生成 skill；生成后把 skill 工厂注册进评测门禁（registerSkillFactory），
 * 并用 baseline vs baseline+新 skill 跑 runEvalGate 出 verdict（供人工拦截）。
 * 非方法论类返回 { decision, draft: null }，不生成。
 */
export async function runSkillGenPipeline(
  opts: SkillGenPipelineOptions,
): Promise<SkillGenPipelineResult> {
  const llm = opts.judgeProvider;
  const decision = await classifyMethodology(opts.content, llm, { sourceFile: opts.sourceFile });
  if (!decision.isMethodology) {
    return { decision, draft: null };
  }

  const draft = await generateFromKnowledge(
    {
      content: opts.content,
      engine: opts.engine,
      id: opts.id,
      sourceFile: opts.sourceFile,
      version: opts.version,
    },
    { write: opts.write !== false, srcDir: opts.srcDir, docDir: opts.docDir },
    llm,
  );

  // 注册工厂，使 runEvalGate 可按快照 id 重建该 skill
  registerGeneratedSkill(draft.rules);

  const candidateSkills: ActiveSkill[] = [
    ...opts.baselineSkills,
    { id: draft.rules.id, engine: draft.rules.engine, version: draft.rules.version, enabled: true },
  ];
  const { report } = await runEvalGate({
    engine: opts.engine,
    baselineSkills: opts.baselineSkills,
    candidateSkills,
    threads: opts.threads,
    kind: opts.kind ?? 'weekly',
    judgeProvider: llm,
    outputDir: opts.outputDir,
  });
  return { decision, draft, evalReport: report };
}

/** 由文件名派生 skill id（去扩展名、非字母数字转下划线） */
export function idFromFilename(file: string): string {
  const base = path.basename(file, path.extname(file));
  return sanitizeId(base);
}

/**
 * 扫描知识目录，对判定为教学/教育方法论的 md 生成能力 skill 草案（供反思流程调用）。
 * 只读生成、可选写盘；不跑评测门禁（门禁由 runSkillGenPipeline / 应用阶段执行）。
 * 返回各草案元信息（SkillDraftMeta）。
 */
export async function scanKnowledgeDirForSkills(opts: {
  dir: string;
  engine: SkillEngine;
  llm?: LLMProvider;
  /** 是否写盘 TS 源码 + 说明文档（默认 false，反思阶段仅生成草案不落盘） */
  write?: boolean;
  srcDir?: string;
  docDir?: string;
  version?: string;
}): Promise<SkillDraftMeta[]> {
  if (!fs.existsSync(opts.dir)) return [];
  const metas: SkillDraftMeta[] = [];
  const files = fs.readdirSync(opts.dir).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const file = path.join(opts.dir, f);
    const content = fs.readFileSync(file, 'utf-8');
    const decision = await classifyMethodology(content, opts.llm, { sourceFile: file });
    if (!decision.isMethodology) continue;
    const id = idFromFilename(f);
    const draft = await generateFromKnowledge(
      {
        content,
        engine: opts.engine,
        id,
        sourceFile: file,
        version: opts.version,
      },
      { write: opts.write === true, srcDir: opts.srcDir, docDir: opts.docDir },
      opts.llm,
    );
    metas.push({
      id: draft.rules.id,
      engine: draft.rules.engine,
      version: draft.rules.version,
      strategy: draft.rules.strategy,
      sourceFile: file,
      srcPath: draft.srcPath,
      docPath: draft.docPath,
    });
  }
  return metas;
}

export type { SkillEngine };

// ---------------------------------------------------------------------------
// §8.2.1 应用步骤：人工拦截确认后，把草案 skill 应用到对应引擎。
// 应用 = 把规则持久化到 data/skills/active.json（已应用注册表）+ 注册评测门禁工厂；
// 引擎装配时经 createEngineManagerFromRegistry 读取注册表，把已应用 skill 叠加到默认组合。
// ---------------------------------------------------------------------------

export interface AppliedSkillInfo {
  id: string;
  engine: SkillEngine;
  version: string;
  appliedAt: string;
  srcPath?: string;
  docPath?: string;
}

/** 已应用注册表文件（相对于存储目录） */
const ACTIVE_FILE = 'skills/active.json';

function activeFilePath(dir: string): string {
  return path.join(dir, ACTIVE_FILE);
}

/** 读取已应用 skill 注册表（不存在/损坏 → 空列表） */
export function listAppliedSkills(opts: { dir: string }): SkillRules[] {
  const file = activeFilePath(opts.dir);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(raw) ? (raw as SkillRules[]) : [];
  } catch {
    return [];
  }
}

function saveAppliedSkills(dir: string, list: SkillRules[]): void {
  const file = activeFilePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
}

/**
 * 应用草案 skill（= 人工拦截确认 + enable）。
 * 幂等：同 (id, engine) 重复应用以新版本覆盖。写盘源码与说明文档（若 generateFromKnowledge 已写，
 * 这里生成器默认会再次写）。返回应用信息。
 */
export function applyGeneratedSkill(
  rules: SkillRules,
  opts: { dir: string },
): AppliedSkillInfo {
  const list = listAppliedSkills(opts).filter(
    (r) => !(r.id === rules.id && r.engine === rules.engine),
  );
  list.push(rules);
  saveAppliedSkills(opts.dir, list);
  registerGeneratedSkill(rules); // 供评测门禁重建该 skill
  return {
    id: rules.id,
    engine: rules.engine,
    version: rules.version,
    appliedAt: new Date().toISOString(),
  };
}

/**
 * 装配引擎 manager：默认组合（socratic.core / profile.core）+ 已应用 skill 叠加。
 * 引擎注入示例（web/index.ts）：
 *   const socratic = new SocraticEngine(llm, createEngineManagerFromRegistry('socratic', opts));
 *   const profile  = new ProfileEngine(store, createEngineManagerFromRegistry('profile', opts));
 */
export function createEngineManagerFromRegistry(
  engine: SkillEngine,
  opts: { dir: string; llm?: LLMProvider },
): StrategyManager {
  const manager =
    engine === 'profile'
      ? createProfileManager()
      : createSocraticManager(opts.llm as LLMProvider);
  for (const rules of listAppliedSkills(opts)) {
    if (rules.engine !== engine) continue;
    manager.register(createSkillFromRules(rules));
  }
  return manager;
}

/** 从已应用注册表移除某 skill（如经评测发现回退需回滚时使用） */
export function removeAppliedSkill(
  id: string,
  engine: SkillEngine,
  opts: { dir: string },
): boolean {
  const list = listAppliedSkills(opts);
  const next = list.filter((r) => !(r.id === id && r.engine === engine));
  if (next.length === list.length) return false;
  saveAppliedSkills(opts.dir, next);
  return true;
}