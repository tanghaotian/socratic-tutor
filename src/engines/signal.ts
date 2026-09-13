import type { LLMProvider } from '../providers/index.js';
import type { AnswerSignal } from '../providers/index.js';

export interface ParseSignalInput {
  answer: string;
  concept?: string;
}

export interface SignalParseResult {
  signal: AnswerSignal;
  confidence: number;
  conceptIds: string[];
  errorCategories: string[];
}

/** structuredCall 返回的原始信号结构 */
interface RawSignal {
  signal: string;
  confidence: number;
  concept_ids?: string[];
  error_categories?: string[];
}

const SIGNAL_WHITELIST: AnswerSignal[] = ['correct', 'confused', 'mistake', 'divergent'];

const SYSTEM_PROMPT = `你是苏格拉底助教，负责判定学习者在某一知识点的回答信号。
请只输出 JSON 对象，字段如下：
- signal: 枚举 correct(理解正确) | confused(困惑/不确定) | mistake(存在错误) | divergent(发散/跑偏或联想扩展)
- confidence: 0-1 的数字，表示你对该判定有多确信
- concept_ids: 数组，命中的知识点 id（可空）
- error_categories: 数组，若为 mistake/confused，给出错误/困惑类别（可空）
只输出 JSON，不要输出任何解释。`;

function userPrompt(input: ParseSignalInput): string {
  const concept = input.concept ? `\n当前学习概念：${input.concept}` : '';
  return `学习者的回答如下：${concept}\n回答内容：\n${input.answer}\n请判定该回答的信号。`;
}

/** 结构化调用失败时的规则兜底：极短/含疑问词 → confused，否则 correct */
function fallbackSignal(answer: string): AnswerSignal {
  const a = answer.trim();
  if (!a || a.length <= 4 || /[?？]|不知道|不会|不懂|不确定/.test(a)) {
    return 'confused';
  }
  return 'correct';
}

function normalize(raw?: RawSignal): SignalParseResult {
  if (!raw) {
    return { signal: 'correct', confidence: 0.4, conceptIds: [], errorCategories: [] };
  }
  const signal: AnswerSignal = SIGNAL_WHITELIST.includes(raw.signal as AnswerSignal)
    ? (raw.signal as AnswerSignal)
    : 'correct';
  const confidence = Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0.4;
  return {
    signal,
    confidence,
    conceptIds: Array.isArray(raw.concept_ids) ? raw.concept_ids : [],
    errorCategories: Array.isArray(raw.error_categories) ? raw.error_categories : [],
  };
}

/**
 * 回答信号解析器（IT2）。
 * 解析用户回答，输出"理解/困惑/错误/发散"四类信号，供教学引擎与画像更新。
 */
export class SignalParser {
  constructor(private llm: LLMProvider) {}

  async parse(input: ParseSignalInput): Promise<SignalParseResult> {
    const res = await this.llm.structuredCall<RawSignal>(
      SYSTEM_PROMPT,
      userPrompt(input),
      {
        type: 'object',
        properties: {
          signal: { type: 'string', enum: SIGNAL_WHITELIST },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          concept_ids: { type: 'array', items: { type: 'string' } },
          error_categories: { type: 'array', items: { type: 'string' } },
        },
        required: ['signal', 'confidence'],
      },
    );

    if (!res.ok) {
      // 结构化失败：降级为规则判定，不中断对话
      return {
        signal: fallbackSignal(input.answer),
        confidence: 0.3,
        conceptIds: input.concept ? [input.concept] : [],
        errorCategories: [],
      };
    }
    return normalize(res.data);
  }
}