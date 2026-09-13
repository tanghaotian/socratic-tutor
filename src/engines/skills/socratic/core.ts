import type { LLMProvider } from '../../../providers/index.js';
import type { AnswerSignal } from '../../../providers/index.js';
import { SignalParser } from '../../signal.js';
import type { CapabilitySkill, SkillContext, SkillResult, SkillMeta } from '../types.js';
import type { TeachingAction, SocraticStrategy, AdaptiveProfile } from '../../socratic.js';

/**
 * 苏格拉底核心能力 skill（IT9 默认激活）。
 * 承接 IT2 SocraticEngine 的确定性路由 + LLM 文案逻辑：题型选择由规则决定（可单测），
 * 文案交由 LLM 生成。作为 `socratic.core` skill 注入 StrategyManager，
 * 保证旧接口（未加 skill）行为不回归。
 */
export function createSocraticCoreSkill(llm: LLMProvider): CapabilitySkill {
  const parser = new SignalParser(llm);
  const meta: SkillMeta = {
    id: 'socratic.core',
    engine: 'socratic',
    version: '0.1.0',
    purpose: '确定性题型路由（open/focus/conflict/self_eval/hint）+ LLM 文案生成',
  };

  return {
    id: meta.id,
    engine: 'socratic',
    version: meta.version,
    describe: () => meta,

    async apply(ctx: SkillContext): Promise<SkillResult> {
      // 1) 解析信号（可注入）
      const signal =
        ctx.signal ?? (await parser.parse({ answer: ctx.input, concept: ctx.concept }));

      // 2) 读取画像/自适应
      const profile = (ctx.profile ?? defaultProfile()) as AdaptiveProfile;
      const depth = profile.adjustDepth(signal.signal);
      const history = ctx.history ?? [];

      // 3) 统计最近连续信号
      const consecutive = latestConsecutive(history, signal.signal);

      // 4) 确定性路由：决定「题型」，再交给 LLM 生成该题型下的文案
      let strategy: SocraticStrategy;
      let promptLevel = depth;

      switch (signal.signal) {
        case 'correct':
          if (consecutive >= CORRECT_SELF_EVAL_THRESHOLD) {
            strategy = 'self_eval';
          } else {
            strategy = 'conflict';
          }
          break;
        case 'confused':
          if (consecutive >= CONFUSED_HINT_THRESHOLD) {
            strategy = 'hint';
          } else {
            strategy = 'focus';
          }
          break;
        case 'mistake':
          strategy = 'focus';
          break;
        case 'divergent':
          strategy = 'open';
          promptLevel = Math.max(0, depth - 1);
          break;
        default:
          strategy = 'focus';
      }

      // 5) 合成文案
      const content = await composeContent(
        llm,
        strategy,
        ctx.input,
        ctx.concept,
        signal.signal,
        history.length,
      );

      const action = buildAction(strategy, content, ctx.concept, promptLevel, signal.signal);
      return { engine: 'socratic', action, meta };
    },
  };
}

/** 连续困惑达到该次数则给提示 */
const CONFUSED_HINT_THRESHOLD = 2;
/** 连续正确达到该次数则引导自我评估 */
const CORRECT_SELF_EVAL_THRESHOLD = 2;

/** 按题型用 LLM 生成提问/反馈文案 */
async function composeContent(
  llm: LLMProvider,
  strategy: SocraticStrategy,
  answer: string,
  concept: string | undefined,
  signal: AnswerSignal,
  turnIndex: number,
): Promise<string> {
  const system = `你是苏格拉底式教学助手。用中文。指导思想：尽量用提问引导学习者自主思考；不要直接给出答案，除非已多次提示仍未理解。根据指定题型生成一句贴合上下文的引导语或问题。只输出这一句，不要多余内容。`;
  const user = `当前题型：${STRATEGY_LABEL[strategy]}。学习概念：${concept ?? '未知'}。学习者刚说的话：${answer}\n请生成合理的引导语/问题。`;
  // 兜底模板：LLM 失败时仍能给出可用的引导
  const fallback = FALLBACK_TEMPLATE[strategy](concept);
  try {
    const text = await llm.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.8, maxTokens: 120 },
    );
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** 组装最终教学动作 */
function buildAction(
  strategy: SocraticStrategy,
  content: string,
  concept: string | undefined,
  promptLevel: number,
  signal: AnswerSignal,
): TeachingAction {
  switch (strategy) {
    case 'hint':
      return { type: 'hint', content, promptLevel };
    case 'self_eval':
      return { type: 'assess_self', content };
    case 'conflict':
      return { type: 'ask', strategy: 'conflict', content, concept, promptLevel };
    case 'open':
      return { type: 'ask', strategy: 'open', content, concept, promptLevel };
    case 'focus':
      if (signal === 'mistake') {
        return {
          type: 'evaluate',
          content,
          feedback: `你的回答需要再看一下：${content}`,
        };
      }
      return { type: 'ask', strategy: 'focus', content, concept, promptLevel };
  }
}

const STRATEGY_LABEL: Record<SocraticStrategy, string> = {
  open: '开放式提问(引导发散联想)',
  focus: '聚焦追问(针对薄弱点细化)',
  conflict: '认知冲突提问(提出反例质疑已知)',
  self_eval: '自我评估(让学习者总结/反思/给分)',
  hint: '提示(给台阶引导，不给答案)',
};

const FALLBACK_TEMPLATE: Record<SocraticStrategy, (c?: string) => string> = {
  open: (c) => (c ? `关于「${c}」，你能想到哪些相关的例子或应用场景？` : '这件事你能想到什么相关的例子或场景吗？'),
  focus: (c) => (c ? `你刚才提到了「${c}」，能再具体解释一下为什么吗？` : '能再具体说说你的推理过程吗？'),
  conflict: (c) => (c ? `如果有一个反例不符合「${c}」，会是什么样？你还能坚持原来的理解吗？` : '如果反过来呢，什么情况下你的理解不成立？'),
  self_eval: () => '用一个词总结你现在的理解？哪部分你其实还没彻底想通？',
  hint: (c) => (c ? `提示：想想「${c}」跟你知道的哪个概念最像？` : '提示：换个更基础的例子想一想。'),
};

/** 默认画像（无画像注入时兜底）：难度固定 1，掌握度 0.5 */
function defaultProfile(): AdaptiveProfile {
  return {
    adjustDepth: () => 1,
    mastery: () => 0.5,
  };
}

/** 返回 history 末尾与给定 signal 相同的连续次数（含本次） */
function latestConsecutive(history: AnswerSignal[], signal: AnswerSignal): number {
  let count = 1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === signal) count++;
    else break;
  }
  return count;
}
