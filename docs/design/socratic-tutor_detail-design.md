# 详细设计文档：Socratic Tutor

- 版本：v1.1.0
- 日期：2026-09-09
- 阶段：方案设计（Project Creator 阶段 2.2）
- 依赖：`docs/design/socratic-tutor_overall-design.md`、`docs/requirements.md`、`docs/development-plan.md`
- 用途：供 AI 只读本文件即可实现代码。
- 版本演进：v1.0（2026-09-02，Phase 1 基线）→ v1.1.0（2026-09-09，0.2.0–0.4.0 全部落地：skill 拔插 / 评测回测门禁 / 学习计划 + 复盘阶段 / 真实语音提供方 / 资料引擎）。详见末尾「版本迭代说明」。

技术栈（已落地）：**Node.js + TypeScript + Fastify + SQLite（node:sqlite，零原生依赖）+ 轻量前端（Vue3 静态托管）**。Provider 抽象，LLM 默认豆包（qwen/deepseek 可切换、可追加任意 OpenAI 兼容模型）。本机便携 Node v24.19.0。

---

## 1. 数据模型

### 1.1 LearnerProfile（学习画像）
```ts
interface LearnerProfile {
  learnerId: string;
  createdAt: string;          // ISO8601
  updatedAt: string;
  mastery: Record<string, {  // key=topicId
    level: number;            // 0.0-1.0 掌握度
    mistakes: string[];       // 历史错误知识点
    strengths: string[];
  }>;
  frequency: {
    totalSessions: number;
    lastStudyDates: string[]; // 最近学习日期（上限 30 条）
    weeklyAvg: number;        // 周均学习次数
  };
  interest: {
    topics: Record<string, number>; // 兴趣权重
    preferences: string[];
  };
  learningSpeed: number;      // 自适应系数
}
```
- 持久化：`SqliteStorage` 以 learnerId 一行 JSON 存 `profiles` 表。
- 画像增量：`applyProfileDelta(profile, delta)` 合并 `ProfileDelta`（masteryDelta/interestDelta/sessionsDelta），供 skill 与交叉确认复用。

### 1.2 TeachingAction（教学动作）
```ts
type TeachingAction =
  | { type: 'ask';   strategy: SocraticStrategy; content: string; concept?: string; promptLevel: number }
  | { type: 'hint';  content: string; promptLevel: number }
  | { type: 'evaluate'; content: string; feedback: string }
  | { type: 'explain'; content: string; concept: string }
  | { type: 'recommend'; resourceIds: string[] }
  | { type: 'assess_self'; content: string };

type SocraticStrategy = 'open' | 'focus' | 'conflict' | 'self_eval' | 'hint';
```

### 1.3 ReflectionReport（反思升级产物）
```ts
interface ReflectionReport {
  id: string;
  date: string;               // ISO8601
  trigger: 'manual' | 'weekly';
  observations: string[];
  improvements: string[];
  newFeatureRequests: string[];
  resourceAdditions: string[];
  skillDrafts?: string[];     // 0.2.0：扫描 knowledge/skills 生成的能力 skill 草案 id（默认不写盘）
  status: 'draft' | 'confirmed' | 'designed' | 'planned' | 'done';
}
```

### 1.4 ConversationMessage（对话记录）
```ts
interface ConversationMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'agent';
  content: string;
  signal?: AnswerSignal;
  audioUrl?: string;          // 语音模式
  createdAt: string;
}
```

### 1.5 学习计划与复盘（0.4.0 新增，src/engines/plans/types.ts）

**画像锚点（锚定 = 对学员学习情况的假设，计划与复盘共同引用）**
```ts
interface AnchorSnapshot {
  initialMastery: Record<string, number>; // 各主题初始掌握度假设（0-1）
  targetDepth: number;                    // 目标深度（1-5）
  targetDifficulty: number;               // 目标难度（0-1）
  learningSpeedBaseline: number;          // 学习速度基线（≥0.1）
  repetitionBias: number;                 // 重复偏向（0-3）
}
```

**学习计划（data/plans/<id>.md）**
```ts
interface PlanGoal {
  topicId: string;
  targetLevel: number;   // 目标掌握度（0-1）
  targetDepth: number;   // 目标深度（1-5）
  sessions: number;      // 计划会话次数
}
interface StudyPlan {
  id: string;            // buildPlanId：<yyyy-MM-dd>-<learnerId>-<sanitized topic>
  learnerId: string;
  period: { start: string; end: string };   // 默认 7 天
  goals: PlanGoal[];
  strategy: string;      // 生成策略说明
  anchors: AnchorSnapshot;                  // 生成时采用的锚点
  status: 'draft' | 'confirmed';            // 文档状态机
  createdAt: string;
  updatedAt: string;
  generatorVersion?: string;                // 策略 id（如 plans.default / plans.adaptive）
}
```

**复盘加权评分（纯确定性，可单测复现）**
```ts
interface ReviewScore {
  goalCompletion: number;  // 计划目标 topic 中掌握度 ≥ targetLevel 的比例
  signalAccuracy: number;  // 周期内 correct/(correct+mistake+confused)，无信号时中性 0.5
  frequencyRate: number;   // 实际学习事件数 / 计划 sessions 和，上限 1
  masteryChange: number;   // 各目标 Δlevel/(targetLevel−initial) 均值，clamp[0,1]
  weighted: number;        // 加权合成（0-1）
}
interface ReviewWeights {
  goalCompletion: number;  // 默认 0.4
  signalAccuracy: number;  // 默认 0.2
  frequencyRate: number;   // 默认 0.2
  masteryChange: number;   // 默认 0.2
}                          // 读取时 clamp≥0 并归一化（和=1）
```

**复盘（data/reviews/<id>.md）**
```ts
interface StudyReview {
  id: string;              // buildReviewId：<yyyy-MM-dd>-<sanitized planId>
  learnerId: string;
  planId: string;
  period: { start: string; end: string };
  scores: ReviewScore;
  findings: string[];      // 复盘发现
  improvementNotes: string[]; // 后续建议
  anchors: AnchorSnapshot;
  status: 'draft' | 'confirmed';
  createdAt: string;
  updatedAt: string;
  generatorVersion?: string;
}
```

**锚定调整审计（data/anchors/<reviewId>.md + SQLite）**
```ts
interface AnchorAdjustment {
  id: string;              // anchor-<reviewId>
  learnerId: string;
  reviewId: string;
  trigger: { streak: number; threshold: number };
  before: AnchorSnapshot;
  after: AnchorSnapshot;
  method: 'llm' | 'heuristic';
  reasons: string[];
  createdAt: string;
}
```

**学习事件（复盘评分的输入源，对话/语音自动记录）**
```ts
interface LearningEvent {
  id: string;
  learnerId: string;
  topicId?: string;
  signal: 'correct' | 'mistake' | 'confused' | 'divergent' | string;
  date: string; // ISO8601
}
```

**计划/复盘策略（可插拔生成能力，进化评估与引擎消费的统一接口）**
```ts
interface PlanReviewStrategy {
  readonly id: string;                       // 如 plans.default / reviews.adaptive
  readonly kind: 'plan' | 'review';
  readonly version: string;
  generatePlan(ctx: StrategyContext): Promise<PlanDraft | null>;    // kind=review 返回 null
  generateReview(ctx: StrategyContext): Promise<ReviewDraft | null>;// kind=plan 返回 null
  describe(): { id: string; version: string; kind: string };
}
interface PlanReviewStrategyConfig {         // data/plans/active.json 条目
  id: string;
  kind: 'plan' | 'review';
  version: string;
  planPrompt?: string;   // LLM 策略的额外要求（进化产物）
  reviewPrompt?: string;
  weights?: ReviewWeights;
  heuristics?: Record<string, number>;
}
interface StrategyContext {
  learnerId: string;
  profile: LearnerProfile;
  anchors: AnchorSnapshot;
  topicId?: string;
  previousPlan?: StudyPlan;
  planId?: string;
  history: { signal: string; topicId?: string; date: string }[];
  llm?: LLMProvider;
  weights: ReviewWeights;
  scores?: ReviewScore;   // 复盘生成时预计算的加权评分
}
```

### 1.6 能力 skill 与评测（0.2.0 新增，见 §8 / §9）
- `CapabilitySkill`（engine=socratic|profile，apply(ctx): SkillResult，describe(): SkillMeta）
- `EvalRequest` / `EvalReport` / `FrozenThread` / `Rubric` / `EngineSnapshot`（见 §9）

---

## 2. 模块与目录结构（已落地）

```
socratic-tutor/
├── docs/                     # 需求/设计/计划/反思产物
├── knowledge/skills/         # book-to-skill 产物 md（RAG 源）
├── data/                     # SQLite + 音频 + 画像(运行时) + 计划/复盘/锚点/评测产物
│   ├── threads/              # 冻结对话线程（评测回放输入）
│   ├── evals/                # 评测报告 <date>_<engine>_<kind>.json
│   ├── plans/                # 学习计划 md + active.json（策略注册表）
│   ├── reviews/              # 复盘 md
│   ├── anchors/              # 锚定调整审计 md
│   └── learner.db            # SQLite（profiles/reflections/study_plans/reviews/anchor_adjustments/learning_events）
├── src/
│   ├── web/index.ts          # Fastify 服务与全部路由
│   ├── engines/
│   │   ├── socratic.ts       # 教学引擎
│   │   ├── signal.ts         # 回答信号解析
│   │   ├── profile.ts        # 学习画像（含 applyProfileDelta）
│   │   ├── reflection.ts     # 反思闭环
│   │   ├── resource.ts       # 资料引擎
│   │   ├── voice.ts          # 非实时语音回合编排
│   │   ├── skills/           # 能力 skill 拔插（types/manager/index + socratic.core/interest/profile.core + generated/）
│   │   ├── eval/             # 评测回测门禁（types/manager/index + backends/selfbuilt + backends/adapters + reflection-gate）
│   │   ├── skillgen/         # 能力 skill 生成链路（知识 md → TS skill）
│   │   └── plans/            # 学习计划 + 复盘（types/util/scoring/crosscheck/anchor/study-plan/review/eval/default-strategy/llm-strategy/index）
│   ├── providers/
│   │   ├── llm/              # LLM Provider 注册表 + openai-compat（doubao/deepseek/qwen/extra）
│   │   ├── asr/              # doubao（真实）+ mock
│   │   ├── tts/              # doubao（真实）+ mock
│   │   ├── reminder/web.ts   # Web 提醒
│   │   └── search/mock.ts    # 联网检索
│   ├── storage/              # sqlite.ts + rag.ts（关键词检索）+ audio.ts
│   ├── scheduler/            # index.ts（每周反思）+ eval-cron.ts（周/月评测）
│   └── index.ts              # 装配与启动
├── public/                   # 前端静态资源（含「计划/复盘」tab）
├── scripts/                  # dev/build
└── package.json
```

---

## 3. Provider 接口（TypeScript，已落地）

```ts
interface LLMProvider {
  id: string;                                  // 'doubao' | 'deepseek' | 'qwen' | extra
  chat(messages: LLMMessage[], opts: LLMOpts): Promise<string>;
  streamChat(messages: LLMMessage[], opts: LLMOpts): AsyncIterable<string>;
  structuredCall<T>(system: string, user: string, schema: TSchema): Promise<StructuredResult<T>>;
}
```
- 注册表 `providers/llm/registry.ts`：`addProvider/getProvider/listLLM`；`LLM_EXTRA_MODELS` 可零代码追加任意 OpenAI 兼容模型。
- 评测 judge 可独立配置（`JUDGE_PROVIDER` / `JUDGE_MODEL`），未配置时跟随主模型。

```ts
interface ASRProvider { id: string; transcribe(audio: Buffer): Promise<string>; }  // 豆包录音文件识别极速版
interface TTSProvider { id: string; synthesize(text: string): Promise<Buffer>; }   // 豆包经典同步合成（wav）
interface ReminderProvider { id: 'web' | 'email' | 'wechat'; notify(title: string, content: string, target?: string): Promise<void>; }
interface SearchProvider { id: string; search(query: string): Promise<SearchResult[]>; }
```
- 语音鉴权：ASR 用 `X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Request-Id / X-Api-Sequence`；TTS 用 `Authorization: Bearer;<token>`。无 key 时回退 Mock 全链路可跑。

---

## 4. API 契约（已落地）

| 方法 | 路径 | 请求 | 返回 |
|---|---|---|---|
| POST | `/api/chat` | `{text?, sessionId?, topicId?}` | `{reply: TeachingAction, profile}` |
| POST | `/api/voice/chat` | multipart（`text?`+`audio` 文件） | `{reply, audioUrl?, profile}` |
| GET | `/api/profile` | — | `LearnerProfile` |
| POST | `/api/learn/topic` | `{topicId, title, targetLevel}` | `{ok, profile}` |
| POST | `/api/resource/summarize` | `{sourceType, content, sourceTitle?}` | `{summary, skillMarkdownPath?}` |
| POST | `/api/resource/search` | `{query}` | `SearchResult[]` |
| POST | `/api/reflect` | `{trigger?}` | `{report: ReflectionReport}` |
| GET | `/api/reflection/latest` | — | `ReflectionReport[]`（草稿优先） |
| POST | `/api/reflect/:id/confirm` | — | `{status:'confirmed'}` |
| POST | `/api/plan/generate` | `{topicId}` | `{plan, markdownPath}` |
| GET | `/api/plan/latest` | — | `StudyPlan` 或 null |
| POST | `/api/plan/:id/confirm` | — | `StudyPlan`（draft→confirmed） |
| POST | `/api/review/generate` | `{planId}` | `{review, markdownPath}` |
| GET | `/api/review/latest` | — | `StudyReview` 或 null |
| POST | `/api/review/:id/confirm` | — | `{review, anchorAdjustment}`（交叉确认 + 锚定反思） |
| GET | `/api/anchors/latest` | — | `AnchorSnapshot` 或 null |
| GET | `/api/strategy/active` | — | `PlanReviewStrategyConfig[]`（active.json） |
| POST | `/api/strategy/eval` | `{candidate, planWeight?, reviewWeight?, minScore?}` | `StrategyEvalReport` |
| WS | `/ws/voice` | 音频流 | 流式文本/音频（Phase 2 实时，预留） |

错误码：`400` 参数错误、`401` 未授权(Provider)、`404` 未找到、`429` Provider 限流、`500` 内部、`502` Provider 上游失败。

---

## 5. 关键算法/流程伪代码

### 5.1 教学引擎 generateSocraticAction（0.1.0，沿用）
```
signal = parseSignal(answer);  profile.update(signal, answer);  adaptive = profile.adaptiveParams(signal);
if confused 连续2次 → hint（promptLevel 依 adaptive.depth 递进）
elif correct 连续2次 → ask(conflict)（深化-认知冲突）
elif divergent → ask(open)（关联兴趣）
elif 需要自评(history) → assess_self
else → ask(focus)
```

### 5.2 回答信号解析 parseSignal（0.1.0，沿用）
`LLMProvider.structuredCall` 判定 `{signal, confidence, conceptIds[], errorCategories[]}`，失败降级规则兜底（confused/mistake/divergent/correct 四类）。

### 5.3 反思闭环 runReflection（0.1.0，沿用）
手动或 cron（默认周五 19:00）触发 → 收集近期对话 + 新增 knowledge 资源 → LLM 生成 `ReflectionReport(draft)` → 落 `data/reflections/<date>-<trigger>.md` + SQLite → Web 提醒 → `confirm` 仅 draft→confirmed → 进入设计/开发计划。0.2.0 起支持扫描 `knowledge/skills` 记录能力 skill 草案（默认不写盘）。

### 5.4 资料引擎 summarize → book-to-skill（0.1.0，沿用）
`summarize`（LLM 结构化总结）→ `bookToSkill` 生成 `knowledge/skills/<slug>.md` → `RAGStore` 轻量关键词检索刷新（**不引入向量库**，向量 RAG 预留）。

### 5.5 学习计划生成（0.4.0 新增）
```
输入：learnerId, topicId
id = buildPlanId(learnerId, topicId, now)          # 幂等：已存在则直接返回已导出 md
profile = getOrCreate(learnerId)
anchors = latestAnchor(store, learnerId) ?? defaultAnchor(profile)   # 锚点优先取最近调整
weights = normalizeWeights(config.plan.reviewWeights)
strategy = 装配层注入（默认 plans.default；active.json 有 plans.* 则用之）
draft = strategy.generatePlan(ctx)                 # LLM 优先，失败/未配置回退默认启发式
plan = { id, goals: draft.goals, strategy, anchors, status: 'draft', generatorVersion }
saveStudyPlan(id, plan); exportPlanMarkdown(plan, data/plans/<id>.md)
```
- 默认启发式（plans.default）：`targetLevel = clamp01(level + 0.25)`；`targetDepth = 锚点深度`；`sessions = (depth-1)*0.8 + (1-level)*3/speed + 1`（clamp 1–12）。
- id 安全化：`sanitizeId` 过滤 Windows/URL 非法字符与控制字符（BUG-001 回归）。

### 5.6 复盘加权评分（0.4.0 新增）
```
weighted = w1*goalCompletion + w2*signalAccuracy + w3*frequencyRate + w4*masteryChange   # w 默认 0.4/0.2/0.2/0.2
goalCompletion = 计划目标中 mastery[topic].level ≥ targetLevel 的比例
signalAccuracy = correct/(correct+mistake+confused)（仅统计计划内主题周期信号；无则 0.5）
frequencyRate = min(1, 周期内事件数 / Σ sessions)
masteryChange = mean( clamp01((cur−initial)/(target−initial)) )
```
复盘生成：`ReviewEngine.run` 按 planId 幂等 → 取周期内 `learning_events` → 算分 → `strategy.generateReview(ctx)`（LLM 优先/默认启发式）→ 落 `data/reviews/<id>.md`。

### 5.7 交叉确认（0.4.0 新增，复盘 confirm 后）
```
对 plan.goals 中每个 topic：
  if mastery[topic].level >= targetLevel：       # 达标
    delta.masteryDelta[topic] = +0.05；delta.interestDelta[topic] = +1.0
applyProfileDelta(profile, delta) 并落库        # 未达标 topic 不抬升，指引记入复盘建议
```

### 5.8 锚定反思（0.4.0 新增，复盘 confirm 后）
```
if 最近连续 anchorStreak（默认 2）次复盘加权分 < anchorThreshold（默认 0.5）:
  before = latestAnchor ?? defaultAnchor(profile)
  LLM structuredCall → {initial_mastery, target_depth, target_difficulty, learning_speed_baseline, repetition_bias, reasons}
  失败/未配置 → 启发式降级：掌握度照实、深度/难度回落（×0.8）、速度基线×0.9、重复偏向=3×(1−min(1,avgCorrect))
  落 SQLite anchor_adjustments + data/anchors/<reviewId>.md 审计
```

### 5.9 组合加权进化评估（0.4.0 新增，计划/复盘策略门禁）
```
baseline = 当前 active 组合（plan+review 各一条）；candidate = 候选组合
对每条冻结线程（StrategyEvalThread）：
  profile = profileSamples[i] ?? stubProfile(thread)
  分别用 baseline/candidate 重放：generatePlan → 组装计划文档；computeReviewScore → generateReview → 组装复盘文档
  judge.structuredCall → {plan_quality(0-10), review_quality(0-10)}
combined = planWeight*plan_quality + reviewWeight*review_quality      # 默认 0.5/0.5
判定：
  judge 降级/缺失 → needs_review（不自动应用）
  combined_candidate < minScore(6) → rejected
  combined_candidate > combined_baseline → accepted（写 data/plans/active.json）
  否则 → needs_review
报告落盘 data/evals/<date>_strategy.json
```

---

## 6. 错误处理与配置

- **Provider 失败**：统一 `ProviderError`；上层降级提示 + 指数退避重试（≤3 次）。
- **LLM 结构化失败**：转自由文本（`structuredFailed`）或回退默认启发式策略（计划/复盘/锚定），不中断流程。
- **语音**：空音频/权限拒绝 → 明确错误码提示重录；TTS 失败 → 仅返回文本。
- **文档状态机**：计划/复盘/反思未确认保持 draft，`confirm` 才推动下一步；定时/生成按 id 幂等（同批不重复生成）。
- **评测**：judge 缺失降级启发式打分并标记 `judgeDegraded`；strategy-eval 降级一律 needs_review。

```ini
# LLM（单一事实来源，OpenAI 兼容）
LLM_PROVIDER=doubao                 # doubao | qwen | deepseek
DOUBAO_API_KEY= / DOUBAO_BASE_URL= / DOUBAO_MODEL=
QWEN_API_KEY= / QWEN_BASE_URL= / QWEN_MODEL=
DEEPSEEK_API_KEY= / DEEPSEEK_BASE_URL= / DEEPSEEK_MODEL=
LLM_EXTRA_MODELS=[{"id","apiKey","baseURL","model"}]
JUDGE_PROVIDER= / JUDGE_MODEL=      # 评测裁判模型（可独立）
# 语音
ASR_PROVIDER= / TTS_PROVIDER=
ASR_APPID= / ASR_ACCESS_TOKEN= / ASR_RESOURCE_ID=
TTS_APPID= / TTS_ACCESS_TOKEN= / TTS_CLUSTER= / TTS_VOICE_TYPE=
# 反思调度
REFLECTION_CRON=0 19 * * 5
REMINDER_PROVIDER=web
# 计划/复盘
PLAN_ANCHOR_STREAK=2                # 连续低分次数触发锚定反思
PLAN_ANCHOR_THRESHOLD=0.5           # 加权分阈值
PLAN_W_GOAL=0.4 / PLAN_W_SIGNAL=0.2 / PLAN_W_FREQ=0.2 / PLAN_W_MASTERY=0.2
PLAN_DIR=./data/plans / REVIEW_DIR=./data/reviews / ANCHOR_DIR=./data/anchors
PLAN_ACTIVE_JSON=./data/plans/active.json
PLAN_EVAL_PLAN_W=0.5 / PLAN_EVAL_REVIEW_W=0.5 / PLAN_EVAL_MIN=6
# 评测调度
EVAL_BACKEND=self-built
EVAL_WEEKLY_CRON=0 20 * * 5 / EVAL_MONTHLY_CRON=0 9 1 * *
EVAL_THREADS_DIR=./data/threads / EVAL_OUTPUT_DIR=./data/evals / EVAL_WEEKLY_SAMPLE=25
# 存储
STORAGE_DIR=./data / KNOWLEDGE_DIR=./knowledge/skills
```

---

## 7. 依赖清单（已落地）

- 后端：**Fastify**、`@fastify/static`、`@fastify/multipart`、`node-cron`；SQLite 用 Node 24 内置 **`node:sqlite`**（零原生依赖）。
- LLM：`openai`（OpenAI 兼容，承载豆包/DeepSeek/Qwen/EXTRA）。
- 语音：豆包 ASR/TTS 走 `fetch` HTTP 直连（无额外 SDK）。
- RAG：**轻量关键词检索 + LLM 筛选**（`storage/rag.ts`，不引入向量库；向量 RAG 预留 Phase 3）。
- 前端：**Vue3**（`public/index.html` 单页，含「计划/复盘」tab）。

---

## 8. 引擎能力 skill 拔插（0.2.0，已落地）

### 8.1 能力策略接口
```ts
interface CapabilitySkill {
  id: string;                       // 如 'socratic.core' / 'socratic.feynman'
  engine: 'socratic' | 'profile';   // 目标引擎
  version: string;
  apply(ctx: SkillContext): SkillResult;   // 同步确定性或经 LLM
  describe(): SkillMeta;            // 供反思/评测使用的中性描述
}
interface SkillContext { input; profile; history; adaptive; llm; kb; }
interface SkillResult { action?: TeachingAction; delta?: ProfileDelta; meta: {skillId; version; rationale?}; }
```

### 8.2 StrategyManager（已落地：src/engines/skills/manager.ts）
- `register / enable / disable / list / snapshot / run(engine, ctx)`；多 skill 按注册序叠加，`prevAction` 注入改写。
- 默认激活组合：`["socratic.core","socratic.feynman"]` + `profile.core`（保证旧行为回归）。
- 装配入口 `createEngineManagerFromRegistry`：默认 core 组合 + `data/skills/active.json` 已应用 skill 叠加；`applyGeneratedSkill` 幂等持久化。

### 8.3 能力 skill 生成链路（0.2.0，已落地：src/engines/skillgen/）
```
knowledge/skills/<知识 md>
  → classifyMethodology（LLM 判定，失败降级启发式）：是否教学/教育方法论类？
      是 → extractRules（purpose/strategy/triggers/phrase/interestBoost）
          → buildSkillCode（纯 TS CapabilitySkill）
          → runSkillGenPipeline：判→生成→注册→跑 EvalGate（§9）出 verdict
          → 人工拦截 → applyGeneratedSkill（data/skills/active.json）→ 引擎自动装配启用
      否 → 仅作 RAG 知识源
```
- 产物形态与 8.1 完全一致，来源升级为知识 md 提炼；反思报告可携带 `skillDrafts` 草案。

---

## 9. 评测回测模块（0.2.0，已落地）

### 9.1 统一评测接口
```ts
interface EvalBackend { id: string; run(req: EvalRequest): Promise<EvalReport>; }  // self-built | promptfoo | agentbench | deepeval
class EvalManager { register(b); setActive(id); run(req); }
interface EvalRequest {
  engine: 'socratic' | 'profile';
  baselineSnapshot: EngineSnapshot;    // 旧版激活 skill 快照
  candidateSnapshot: EngineSnapshot;   // 新版快照
  threads: FrozenThread[];             // 冻结对话线程
  rubric?: Rubric;                     // 默认：engagement 0.3 / nondirect(NDAR) 0.3 / clarity 0.2 / adaptivity 0.2
  judgeProvider: LLMProvider;          // 裁判模型（可独立）
  runner: SnapshotRunner;              // 快照重放器
}
```

### 9.2 判定逻辑（EvalGate）
- 逐线程 baseline/candidate 双快照重放 → judge LLM 打分 + A/B 裁定；judge 失败降级启发式（`judgeDegraded=true`）。
- 判定：**任一核心维（engagement/NDAR）回退 → rejected**；否则候选各维均值 ≥6 且加权 delta>0 → accepted；否则 needs_review。
- **最终一律人工拦截确认**后才应用 skill（A/B winRate 仅作参考列示）。

### 9.3 调度与产物
- 每周抽样（`EVAL_WEEKLY_SAMPLE=25`）出周报，每月全量出月报（`scheduler/eval-cron.ts`）；线程读 `data/threads/`，报告落 `data/evals/<date>_<engine>_<kind>.json`。
- 快照：`data/evals/snapshots/{socratic,profile}.{baseline,candidate}.json`（随版本演进维护）。

---

## 10. 部署与演进边界（预留）

- **实时语音**：Phase 2 WebSocket（`/ws/voice`）独立演进，不影响文本链。
- **向量 RAG**：当前关键词检索；需要语义检索/去重时优先 sqlite-vec（零新基建），其次 LanceDB/Qdrant。
- **多节点**：Web 层无状态可横扩；SQLite 单写主 + Litestream 只读副本或按 learnerId 分片；定时任务（反思/评测/复盘）需分布式锁防重复执行。
- **MCP Server**：见 §11，预留。

---

## 11. IDE 集成（MCP，预留）

暴露 Tools：`chat_socratic`、`get_learner_profile`、`trigger_reflection`、`confirm_upgrade`、`summarize_resource`、`plan_generate`、`review_generate`。实现为进程外/HTTP JSON-RPC，Node 侧统一封装。

---

## 12. 版本迭代说明

### v1.0（2026-09-02）
- 初始详细设计：文本对话 + 画像/自适应 + 反思闭环 + Web + 非实时语音 + 资料引擎/RAG 基础（IT1–IT8，0.1.0）。

### v1.1.0（2026-09-09，对应软件 0.2.0–0.4.0）
- **§1.3/§8/§9**：能力 skill 拔插 + 评测回测门禁（0.2.0，IT9/IT10/IT10b）。
- **§1.5/§5.5–5.9/§4**：学习计划 + 复盘阶段（0.4.0，IT14）：计划/复盘 md + 交叉确认 + 加权评分 + 锚定反思 + 组合加权进化评估；新增 4 张表（study_plans/reviews/anchor_adjustments/learning_events）、9 条路由、前端「计划/复盘」tab。
- **§3/§4**：豆包真实 ASR/TTS 提供方落地；语音鉴权与配置项新增。
- **§6**：配置段扩展（plan/eval/voice/judge），`LLM_EXTRA_MODELS` 零代码追加模型。
- **§7**：SQLite 改用 Node 内置 `node:sqlite`；依赖收敛（fastify 系列 + node-cron + openai）。
- **§2**：目录结构更新（plans/eval/skills/skillgen/scheduler/eval-cron）。

---

本详细设计为开发实现唯一依据，随迭代更新（总体设计变更时同步）。
