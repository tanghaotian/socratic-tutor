import type { EvalBackend } from '../manager.js';
import type {
  EvalReport,
  EvalRequest,
  EngineObservation,
  FrozenThread,
  Rubric,
  RubricDimension,
} from '../types.js';

/** 默认教学评测 rubric（各维 0-10；core 维回退即拒） */
export const DEFAULT_RUBRIC: Rubric = {
  dimensions: [
    { id: 'engagement', label: '启发度（引导自主思考）', weight: 0.3, core: true },
    { id: 'nondirect', label: '不直接给答案(NDAR)', weight: 0.3, core: true },
    { id: 'clarity', label: '表达清晰', weight: 0.2, core: false },
    { id: 'adaptivity', label: '自适应贴合', weight: 0.2, core: false },
  ],
};

/** judge structuredCall 返回的原始结构 */
interface RawJudge {
  dimension_scores?: Record<string, number>;
  ab?: 'candidate' | 'baseline' | 'tie';
}

interface ThreadJudge {
  scores: Record<string, { baseline: number; candidate: number }>;
  ab: 'candidate' | 'baseline' | 'tie';
  /** 是否走启发式降级（无裁判 LLM 或 judge 调用失败） */
  degraded: boolean;
}

/**
 * 自建轻量评测后端（IT10，detail.md §9.2/9.3）。
 * 对每条冻结线程分别用 baseline / candidate 快照重放（经 SnapshotRunner），
 * 由裁判 LLM（LLM-as-Judge）按 rubric 打分并做 A/B 裁定；
 * 无裁判 LLM 时降级为确定性启发式打分（judgeDegraded=true）。
 */
export class SelfBuiltBackend implements EvalBackend {
  readonly id = 'self-built';

  async run(req: EvalRequest): Promise<EvalReport> {
    const rubric = req.rubric ?? DEFAULT_RUBRIC;
    const dims = rubric.dimensions;
    if (!req.runner) throw new Error('self-built 后端需要 req.runner（快照重放器）');
    const threads = req.threads;
    const sampledFrom = req.sampledFrom ?? threads.length;

    // 逐线程重放 + 打分
    const agg: Record<string, { baseline: number; candidate: number }> = {};
    for (const d of dims) agg[d.id] = { baseline: 0, candidate: 0 };
    let candidateWins = 0;
    let baselineWins = 0;
    let ties = 0;
    let degraded = false;

    for (const thread of threads) {
      const [baseObs, candObs] = await Promise.all([
        req.runner.run(req.baselineSnapshot.activeSkills, thread),
        req.runner.run(req.candidateSnapshot.activeSkills, thread),
      ]);
      const tj = await judgeThread(req.judgeProvider, rubric, thread, baseObs, candObs);
      if (tj.degraded) degraded = true;
      if (tj.ab === 'candidate') candidateWins++;
      else if (tj.ab === 'baseline') baselineWins++;
      else ties++;
      for (const d of dims) {
        agg[d.id].baseline += tj.scores[d.id]?.baseline ?? 0;
        agg[d.id].candidate += tj.scores[d.id]?.candidate ?? 0;
      }
    }

    // 聚合为均值
    const n = threads.length || 1;
    const rubricScores: Record<string, { baseline: number; candidate: number; delta: number }> = {};
    for (const d of dims) {
      const baseline = round1(agg[d.id].baseline / n);
      const candidate = round1(agg[d.id].candidate / n);
      rubricScores[d.id] = { baseline, candidate, delta: round1(candidate - baseline) };
    }

    const total = candidateWins + baselineWins + ties;
    const winRateDelta = total > 0 ? round2((candidateWins - baselineWins) / total) : 0;

    // 判定（detail.md §9.3，阈值已确认：rubric 严格 ≥6/10 且 NDAR 不可回退）
    const reasons: string[] = [];
    let verdict: EvalReport['verdict'] = 'accepted';

    const coreRegress = dims.filter(
      (d) => d.core && rubricScores[d.id].delta < 0,
    );
    if (coreRegress.length > 0) {
      verdict = 'rejected';
      reasons.push(`核心维回退：${coreRegress.map((d) => d.label).join('、')}`);
    }

    const weightedDelta = round2(
      dims.reduce((s, d) => s + d.weight * rubricScores[d.id].delta, 0),
    );
    const candidateAvg = round1(
      dims.reduce((s, d) => s + rubricScores[d.id].candidate, 0) / dims.length,
    );

    if (verdict !== 'rejected') {
      if (candidateAvg >= 6 && weightedDelta > 0) {
        reasons.push(`各维 candidate 均值 ${candidateAvg}≥6 且加权 delta ${weightedDelta}>0`);
      } else if (candidateAvg >= 6) {
        verdict = 'needs_review';
        reasons.push(`candidate 达标(均分 ${candidateAvg}≥6)但加权 delta=${weightedDelta} 无提升，需人工裁定`);
      } else {
        verdict = 'needs_review';
        reasons.push(`candidate 均分 ${candidateAvg}<6，未达标`);
      }
    }
    if (degraded) reasons.push('judge 降级：未配置裁判 LLM，采用启发式打分，结果仅供参考');

    return {
      id: `${req.engine}-eval-${Date.now()}`,
      engine: req.engine,
      created: new Date().toISOString(),
      metrics: {
        rubric: rubricScores,
        abWinRate: { candidateWins, baselineWins, ties, winRateDelta },
        behavior: { asserted: false, violations: [] },
      },
      verdict,
      reasons,
      judgeDegraded: degraded,
      threadsReplayed: threads.length,
      sampledFrom,
    };
  }
}

/** 对一条线程做 rubric 打分 + A/B 裁定（LLM-as-Judge，失败降级启发式） */
async function judgeThread(
  judge: EvalRequest['judgeProvider'],
  rubric: Rubric,
  thread: FrozenThread,
  base: EngineObservation,
  cand: EngineObservation,
): Promise<ThreadJudge> {
  const dims = rubric.dimensions;
  const prompt = buildJudgePrompt(rubric, thread, base, cand);

  try {
    const res = await judge.structuredCall<RawJudge>(JUDGE_SYSTEM, prompt, {
      type: 'object',
      properties: {
        dimension_scores: {
          type: 'object',
          additionalProperties: { type: 'number', minimum: 0, maximum: 10 },
        },
        ab: { type: 'string', enum: ['candidate', 'baseline', 'tie'] },
      },
      required: ['dimension_scores', 'ab'],
    });
    if (res.ok && res.data.dimension_scores) {
      const scores: ThreadJudge['scores'] = {};
      for (const d of dims) {
        const b = res.data.dimension_scores![d.id];
        scores[d.id] = {
          baseline: clampScore(b),
          candidate: clampScore(b),
        };
      }
      // LLM 只对 candidate 独立打分；baseline 若无显式分数，用同分（保守），
      // 实际 delta 由 A/B 与启发式补差体现。此处简化：直接按 A/B 微调。
      const ab = res.data.ab ?? 'tie';
      adjustByAb(scores, dims, ab);
      return { scores, ab, degraded: false };
    }
  } catch {
    /* 落到启发式降级 */
  }
  return { scores: heuristicScores(dims, base, cand), ab: heuristicAb(base, cand), degraded: true };
}

/** 依据 A/B 裁定微调各维（candidate 胜 → candidate+0.5，负 → -0.5），体现相对差异 */
function adjustByAb(
  scores: Record<string, { baseline: number; candidate: number }>,
  dims: RubricDimension[],
  ab: 'candidate' | 'baseline' | 'tie',
): void {
  const d = ab === 'candidate' ? 0.5 : ab === 'baseline' ? -0.5 : 0;
  for (const dim of dims) {
    scores[dim.id].candidate = clampScore(scores[dim.id].candidate + d);
  }
}

/** 启发式打分（无裁判 LLM）：基准 7 分，按观测文本长度/提问词数微调 */
function heuristicScores(
  dims: RubricDimension[],
  base: EngineObservation,
  cand: EngineObservation,
): ThreadJudge['scores'] {
  const baseProbe = probe(cand.summary) - probe(base.summary);
  const scores: ThreadJudge['scores'] = {};
  for (const d of dims) {
    // 各维按同一相对质量扰动；保持可复现
    const offset = d.id === 'nondirect' ? -baseProbe * 0.3 : baseProbe * 0.3;
    scores[d.id] = { baseline: 7, candidate: clampScore(7 + offset) };
  }
  return scores;
}

/** 启发式 A/B：candidate 观测更长或含更多提问词视为更优 */
function heuristicAb(base: EngineObservation, cand: EngineObservation): 'candidate' | 'baseline' | 'tie' {
  const d = probe(cand.summary) - probe(base.summary);
  if (d > 0.2) return 'candidate';
  if (d < -0.2) return 'baseline';
  return 'tie';
}

/** 观测文本质量探针：长度与提问词计数归一化 */
function probe(text: string): number {
  const q = (text.match(/[？?]|为什么|怎样|怎么|如何|如果/gi) ?? []).length;
  return text.length / 1000 + q / 10;
}

const JUDGE_SYSTEM = `你是教学评测裁判。对同一批学习对话，比较"基线版本引擎"与"候选版本引擎"的回复质量。
按维度为候选版本打分（0-10，10 最优），并给出 A/B 裁定（candidate 明显更优→candidate；明显更差→baseline；相当→tie）。
只输出 JSON：
- dimension_scores: { <维度id>: 0-10 }
- ab: "candidate" | "baseline" | "tie"
只输出 JSON。`;

function buildJudgePrompt(
  rubric: Rubric,
  thread: FrozenThread,
  base: EngineObservation,
  cand: EngineObservation,
): string {
  const dimDesc = rubric.dimensions.map((d) => `- ${d.id}(${d.label})`).join('\n');
  const turns = thread.turns.map((t) => `${t.role === 'user' ? '学习者' : '助手'}: ${t.content}`).join('\n');
  return `维度定义：\n${dimDesc}\n\n冻结对话线程：\n${turns}\n\n基线回复：\n${base.summary || '(空)'}\n\n候选回复：\n${cand.summary || '(空)'}\n\n请按维度给候选版本打分并做 A/B 裁定。`;
}

function clampScore(v: number): number {
  return Math.min(10, Math.max(0, Number.isFinite(v) ? v : 7));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
