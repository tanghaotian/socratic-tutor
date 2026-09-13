import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider, SearchProvider, SearchResult } from '../providers/index.js';
import type { EmbeddingProvider } from '../providers/llm/embeddings.js';
import { RAGStore, type RagHit, type RagBackend } from '../storage/rag.js';

/** 资料类型 */
export type SourceType = 'book' | 'paper' | 'video';

/** 结构化总结（LLM 输出） */
export interface ResourceSummary {
  sourceTitle?: string;
  keyPoints: string[];
  teachingImplications: string[]; // 对教学/画像/自适应的启示
  followups?: string[];
}

/** Raw 结构化结果 */
interface RawSummary {
  key_points?: string[];
  teaching_implications?: string[];
  followups?: string[];
}

export interface Report {
  summary: string;
  skillMarkdownPath?: string;
}

const SYSTEM_PROMPT = `你是学习资料分析师，对书籍/论文/视频做结构化总结，并提炼其教学与自适应启示。
只输出 JSON 对象，字段：
- key_points: string[]，核心要点
- teaching_implications: string[]，对教学引擎/学习画像/自适应的可操作启示
- followups: string[]（可空），可进一步检索/深入的问题
只输出 JSON。`;

function buildUserPrompt(sourceType: SourceType, content: string, sourceTitle?: string): string {
  return `资料类型：${sourceType}\n${sourceTitle ? `标题：${sourceTitle}\n` : ''}资料内容：\n${content}`;
}

function normalize(raw: RawSummary): ResourceSummary {
  return {
    keyPoints: raw.key_points ?? [],
    teachingImplications: raw.teaching_implications ?? [],
    followups: raw.followups ?? [],
  };
}

/**
 * 资料引擎（IT7，详见 detail.md 5.4）。
 * - summarize：对书籍/论文/视频做 LLM 结构化总结
 * - bookToSkill：将资料整理为本地 md 知识（knowledge/skills/<slug>.md），并刷新 RAG
 * - search：联网检索（SearchProvider）
 * - queryRag：对本地知识库做轻量关键词检索
 */
export class ResourceEngine {
  private rag: RAGStore;

  constructor(
    private llm: LLMProvider,
    private search: SearchProvider,
    private knowledgeDir: string,
    opts: { embedding?: EmbeddingProvider; ragBackend?: RagBackend; rag?: RAGStore } = {},
  ) {
    this.rag = opts.rag ?? new RAGStore(knowledgeDir, {
      embedding: opts.embedding,
      backend: opts.ragBackend,
    });
  }

  /** 结构化总结 */
  async summarize(sourceType: SourceType, content: string, sourceTitle?: string): Promise<ResourceSummary> {
    const res = await this.llm.structuredCall<RawSummary>(
      SYSTEM_PROMPT,
      buildUserPrompt(sourceType, content, sourceTitle),
      {
        type: 'object',
        properties: {
          key_points: { type: 'array', items: { type: 'string' } },
          teaching_implications: { type: 'array', items: { type: 'string' } },
          followups: { type: 'array', items: { type: 'string' } },
        },
        required: ['key_points', 'teaching_implications'],
      },
    );
    if (!res.ok) {
      // 结构化失败：降级为自由文本摘要标记
      return { keyPoints: [content.slice(0, 200)], teachingImplications: [], followups: [] };
    }
    return normalize(res.data);
  }

  /** book-to-skill：总结并生成 knowledge/skills/<slug>.md，刷新 RAG */
  async bookToSkill(sourceType: SourceType, content: string, sourceTitle?: string): Promise<ResourceSummary & { file: string }> {
    const summary = await this.summarize(sourceType, content, sourceTitle);
    const title = sourceTitle ?? `未命名${sourceType}`;
    const slug = slugify(title);
    const md = buildSkillMarkdown(title, sourceType, summary);

    fs.mkdirSync(this.knowledgeDir, { recursive: true });
    const file = path.join(this.knowledgeDir, `${slug}.md`);
    fs.writeFileSync(file, md, 'utf-8');
    this.rag.reload(); // 新增后刷新检索索引
    await this.rag.ensureVectors(); // 若有 embedding，同步重建成向量索引（幂等）
    return { ...summary, file };
  }

  /** 联网检索 */
  async searchWeb(query: string): Promise<SearchResult[]> {
    return this.search.search(query);
  }

  /** 本地知识库关键词检索（同步，回归兼容 IT7） */
  queryRag(query: string, topK?: number): RagHit[] {
    return this.rag.search(query, topK);
  }

  /** 本地知识库混合/语义检索（IT15）：向量优先 + 关键词兜底；未启用 hybrid 时等同关键词 */
  async queryRagHybrid(query: string, topK?: number): Promise<RagHit[]> {
    return this.rag.searchHybrid(query, topK);
  }
}

function buildSkillMarkdown(title: string, type: SourceType, s: ResourceSummary): string {
  const implications = s.teachingImplications.length ? s.teachingImplications.map((k) => `- ${k}`) : ['- 暂无'];
  const followups = s.followups?.length ? s.followups.map((k) => `- ${k}`) : ['- 暂无'];
  const lines = [
    `# ${title}`,
    '',
    `> 类型：${type} · 来源：book-to-skill 整理`,
    '',
    '## 核心要点',
    ...s.keyPoints.map((k) => `- ${k}`),
    '',
    '## 教学与自适应启示',
    ...implications,
    '',
    '## 可进一步探索',
    ...followups,
    '',
  ];
  return lines.join('\n');
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[\u4e00-\u9fa5]/g, (c) => encodeURIComponent(c))
    .replace(/[^a-z0-9%-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40);
  return base || 'untitled';
}