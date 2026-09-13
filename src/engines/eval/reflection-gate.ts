import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../../providers/index.js';
import type { ActiveSkill, CapabilitySkill } from '../skills/index.js';
import { StrategyManager, createSocraticCoreSkill, createInterestSkill, createProfileCoreSkill } from '../skills/index.js';
import { SocraticEngine } from '../socratic.js';
import { ProfileEngine, type LearnerProfile } from '../profile.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { EvalManager, type EvalBackend } from './manager.js';
import { SelfBuiltBackend, DEFAULT_RUBRIC } from './backends/selfbuilt.js';
import { externalBackends } from './backends/adapters.js';
import type {
  EvalEngine,
  EvalReport,
  FrozenThread,
  SnapshotRunner,
  EngineObservation,
} from './types.js';

/**
 * 能力 skill 工厂注册表：按 id 重建 skill（snapshot 只有 id/version）。
 * 反思流程生成新 skill（§8.2.1）后可 registerSkillFactory 注册，使回测可重建。
 */
const SKILL_FACTORIES: Record<string, (llm?: LLMProvider) => CapabilitySkill> = {
  'socratic.core': (llm) => createSocraticCoreSkill(llm!),
  'socratic.interest': () => createInterestSkill(),
  'profile.core': () => createProfileCoreSkill(),
};

/** 注册能力 skill 工厂（供未来生成的 skill 接入回测） */
export function registerSkillFactory(id: string, factory: (llm?: LLMProvider) => CapabilitySkill): void {
  SKILL_FACTORIES[id] = factory;
}

/** 按快照条目重建 skill（未注册的 id 抛错） */
function buildSkill(s: ActiveSkill, llm?: LLMProvider): CapabilitySkill {
  const factory = SKILL_FACTORIES[s.id];
  if (!factory) throw new Error(`回测无法重建 skill: ${s.id}（请先 registerSkillFactory）`);
  return factory(llm);
}

/** 无真实 LLM 时使用的降级 provider：全部调用抛错，触发引擎 fallback 与 judge 启发式 */
class DegradedProvider implements LLMProvider {
  readonly id = 'degraded';
  async chat(): Promise<string> {
    throw new Error('no llm configured');
  }
  async *streamChat(): AsyncIterable<string> {
    throw new Error('no llm configured');
  }
  async structuredCall<T>(): Promise<{ ok: false; message: string }> {
    return { ok: false, message: 'no llm configured' };
  }
}

/** 教学引擎快照重放器：重建 skill 组合，逐轮生成回复 */
function buildSocraticRunner(llm: LLMProvider): SnapshotRunner {
  return {
    async run(activeSkills: ActiveSkill[], thread: FrozenThread): Promise<EngineObservation> {
      const manager = new StrategyManager();
      for (const s of activeSkills) manager.register(buildSkill(s, llm));
      const engine = new SocraticEngine(llm, manager);
      const texts: string[] = [];
      for (const turn of thread.turns) {
        if (turn.role !== 'user') continue;
        const action = await engine.generateAction({
          answer: turn.content,
          concept: thread.topic,
          signal: turn.signal
            ? { signal: turn.signal, confidence: 1, conceptIds: [], errorCategories: [] }
            : undefined,
        });
        texts.push('content' in action ? action.content : '');
      }
      return { texts, summary: texts.join('\n') };
    },
  };
}

/** 画像引擎快照重放器：重建 skill 组合，逐轮更新画像，输出画像摘要观测 */
function buildProfileRunner(llm: LLMProvider): SnapshotRunner {
  return {
    async run(activeSkills: ActiveSkill[], thread: FrozenThread): Promise<EngineObservation> {
      const manager = new StrategyManager();
      for (const s of activeSkills) manager.register(buildSkill(s, llm));
      const store = new SqliteStorage(':memory:');
      const engine = new ProfileEngine(store, manager);
      let profile: LearnerProfile | undefined;
      for (const turn of thread.turns) {
        if (turn.role !== 'user') continue;
        profile = await engine.updateFromSignal('eval-user', turn.signal ?? 'correct', thread.topic);
      }
      profile = profile ?? engine.getOrCreate('eval-user');
      return { texts: [], summary: profileSummary(profile, thread.topic) };
    },
  };
}

/** 画像观测摘要（供 judge 打分） */
function profileSummary(p: LearnerProfile, topicId?: string): string {
  const m = topicId ? p.mastery[topicId] : undefined;
  const lvl = m ? `${Math.round(m.level * 10)}/10` : 'n/a';
  const interest = topicId ? String(Math.round((p.interest.topics[topicId] ?? 0) * 10) / 10) : 'n/a';
  const mistakes = m ? String(m.mistakes.length) : '0';
  return `画像摘要：topic=${topicId ?? 'default'} 掌握度=${lvl} 兴趣权重=${interest} 错误次数=${mistakes} 会话数=${p.frequency.totalSessions}`;
}

export interface EvalGateOptions {
  engine: EvalEngine;
  /** 基线（旧版）激活 skill 快照 */
  baselineSkills: ActiveSkill[];
  /** 候选（含新 skill）激活 skill 快照 */
  candidateSkills: ActiveSkill[];
  threads: FrozenThread[];
  /** 评测产物目录（默认 data/evals） */
  outputDir?: string;
  kind?: 'weekly' | 'monthly';
  /** 全量数（每月）或抽样数（每周），默认 = threads.length */
  sampledFrom?: number;
  /** 裁判模型（可独立于主讲模型；缺省用同一 llm 或降级） */
  judgeProvider?: LLMProvider;
  /** 评测后端 id（默认 self-built） */
  backendId?: string;
}

export interface EvalGateResult {
  report: EvalReport;
  file: string;
}

/**
 * 评测回测门禁（IT10，detail.md §9.4/9.5）。
 * 反思生成新 skill 后调用：baseline vs candidate 快照回放冻结线程，
 * 输出周报/月报（含 rubric / A/B / verdict），落盘 data/evals/<date>_<engine>_<kind>.json。
 * 最终 verdict 一律需人工拦截确认后才应用。
 */
export async function runEvalGate(opts: EvalGateOptions): Promise<EvalGateResult> {
  const llm = opts.judgeProvider ?? new DegradedProvider();

  // 装配评测管理器：默认 self-built，可切换外部框架后端（配置 backendId）
  const manager = new EvalManager();
  manager.register(new SelfBuiltBackend());
  for (const b of externalBackends) manager.register(b);
  const backendId = opts.backendId ?? 'self-built';
  manager.setActive(backendId);

  const runner: SnapshotRunner =
    opts.engine === 'profile' ? buildProfileRunner(llm) : buildSocraticRunner(llm);

  const report = await manager.run({
    engine: opts.engine,
    baselineSnapshot: { label: 'baseline', activeSkills: opts.baselineSkills },
    candidateSnapshot: { label: 'candidate', activeSkills: opts.candidateSkills },
    threads: opts.threads,
    rubric: DEFAULT_RUBRIC,
    judgeProvider: llm,
    runner,
    sampledFrom: opts.sampledFrom,
  });

  // 落盘 data/evals/<date>_<engine>_<kind>.json
  const kind = opts.kind ?? 'weekly';
  const date = new Date().toISOString().slice(0, 10);
  const evalsDir = opts.outputDir ?? path.resolve('data/evals');
  fs.mkdirSync(evalsDir, { recursive: true });
  const file = path.join(evalsDir, `${date}_${opts.engine}_${kind}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
  return { report, file };
}

export type { EvalBackend };
