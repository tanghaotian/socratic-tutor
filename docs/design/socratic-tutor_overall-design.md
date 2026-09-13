# 总体设计文档：Socratic Tutor

- 版本：v1.1.0
- 日期：2026-09-09
- 阶段：方案设计（Project Creator 阶段 2.1）
- 依赖：`docs/requirements.md`、`docs/design/debate/*`、`docs/design/socratic-tutor_detail-design.md`（详细设计）
- 技术选型结论：**Node.js/TypeScript 单体（Fastify + Vue）+ 强 Provider 抽象 + 轻量 md 关键词检索 + SQLite（node:sqlite）+ 预留 Python sidecar 边界**（见 debate/synthesis.md 与 development-plan.md OQ 节）

> 本文件供**人**审查。重点审查业务逻辑是否合理、总体框架是否清晰、系统边界是否合理。
> 版本演进：v1.0（2026-09-02）→ v1.1.0（2026-09-09，skill 拔插 / 评测门禁 / 学习计划 + 复盘阶段落地）。详见 §7 版本迭代说明。

---

## 1. 系统流程图

苏格拉底对话主流程（文本 + 非实时语音）：

```mermaid
flowchart TD
    A[用户输入<br/>文本 或 整段语音] --> B{输入方式}
    B -->|文本| C[文本消息入队]
    B -->|语音| D[整段录音文件上传]
    D --> E[ASR Provider 转写为文本]
    C --> F[会话上下文组装]
    E --> F
    F --> G[RAG 检索知识库]
    G --> H[Socratic Engine 生成教学动作]
    H --> I{动作类型}
    I -->|ask/评估| J[返回文本]
    I -->|需播报| K[TTS 合成]
    K --> L[返回音频]
    J --> M[前端展示]
    L --> M
    M --> N[用户再次回答]
    N --> O[回答信号解析]
    O --> P[更新学习画像 Profile]
    P --> Q[自适应调整参数]
    Q --> F
```

学习计划 → 复盘自我进化闭环（0.4.0 新增）：

```mermaid
flowchart LR
    A[生成学习计划 md] --> B[周期内对话/语音<br/>自动记录学习事件]
    B --> C[周期结束生成复盘 md<br/>加权评分]
    C --> D{确认复盘}
    D -->|达标| E[交叉确认<br/>画像增量]
    D -->|连续低分| F[锚定反思<br/>LLM 修正锚点 + 审计]
    E --> G[策略进化评估<br/>plan+review 组合加权]
    F --> G
    G -->|accepted| H[应用至 active 策略<br/>下一周期更优计划]
```

异常分支：无音频→提示重录音；Provider 失败→降级提示并重试；RAG 无命中→回退通用 LLM；LLM 结构化失败→回退启发式策略（计划/复盘/锚定/评测降级）。

---

## 2. 时序图

```mermaid
sequenceDiagram
    participant U as 用户/浏览器
    participant W as Web 服务(Node/TS)
    participant P as Profile引擎
    participant S as Socratic Engine
    participant R as RAG
    participant L as LLM Provider
    U->>W: POST /api/chat {text}
    W->>R: 检索 knowledge/skills 相关片段
    R-->>W: 相关片段
    W->>W: 组装上下文(历史+画像+片段)
    W->>L: structuredCall(生成教学动作)
    L-->>W: 教学动作(signal/type/content)
    W->>S: 解析/校验回答信号
    S->>P: 更新画像(回答质量/频率)
    P-->>S: 自适应参数(难度/深度)
    S-->>W: 生成最终提问/讲解
    W-->>U: 返回文本(可选音频URL)
```

学习计划 / 复盘 / 进化评估时序（0.4.0）：

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as Web 服务
    participant PE as Plan/Review 引擎
    participant AN as 锚定引擎
    participant EV as 策略进化评估
    participant DB as SQLite + md
    U->>W: POST /api/plan/generate {topicId}
    W->>PE: 取画像 + 最新锚点 → 生成计划
    PE->>DB: 落 study_plans + data/plans/<id>.md(draft)
    U->>W: POST /api/plan/:id/confirm
    U->>W: 周期内 /api/chat（自动记录 learning_events）
    U->>W: POST /api/review/generate {planId}
    W->>PE: 周期事件加权评分 → 生成复盘
    PE->>DB: 落 reviews + data/reviews/<id>.md(draft)
    U->>W: POST /api/review/:id/confirm
    W->>PE: 交叉确认 → 画像增量（达标抬升）
    W->>AN: 连续低分 → 锚定反思修正 + 审计
    AN-->>W: AnchorAdjustment
    U->>W: POST /api/strategy/eval {candidate}
    W->>EV: 冻结线程重放 → judge 组合加权打分
    EV-->>W: verdict(accepted/rejected/needs_review)
    W->>DB: accepted → 写 data/plans/active.json
```

反思升级闭环时序：

```mermaid
sequenceDiagram
    participant Cron as Scheduler(周五19:00)
    participant REF as Reflection Engine
    participant REM as Reminder Provider(web)
    participant U as 用户
    Cron->>REF: trigger()
    REF->>REF: 收集近期对话+新资料(+能力skill草案)
    REF->>REF: 生成升级需求文档(draft)
    REF->>REM: notify(升级文档待审阅)
    REM-->>U: Web 页面角标提示
    U->>REF: POST /api/reflect/:id/confirm
    REF->>REF: 状态 confirmed
    REF-->>U: 进入设计/开发计划
```

---

## 3. 系统边界图

```mermaid
graph LR
    subgraph 系统边界
        W[Web 服务<br/>Node/TS]
        E[Engine层<br/>Socratic/Profile/<br/>Reflection/Resource/Voice]
        E2[能力与评测引擎<br/>Skills拔插/Plan+Review<br/>EvalGate/SkillGen]
        ST[Storage<br/>SQLite+文件+关键词RAG]
        SCH[Scheduler<br/>反思/评测调度]
        MCP[MCP Server 预留]
    end
    subgraph 外部依赖
        LLM[LLM Provider<br/>豆包/DeepSeek/Qwen]
        JUDGE[评测裁判模型<br/>LLM-as-Judge]
        ASR[ASR Provider 豆包]
        TTS[TTS Provider 豆包]
        SEARCH[联网检索]
        PS[Python sidecar 预留<br/>本地AI边界]
    end
    subgraph 客户端
        UI[浏览器 Web UI<br/>含计划/复盘tab]
        IDE[TRAE 等 IDE]
    end
    UI --> W
    IDE --> MCP
    MCP --> W
    W --> LLM
    W --> JUDGE
    W --> ASR
    W --> TTS
    W --> SEARCH
    W -.撞墙时接.-> PS
    W --> E
    W --> E2
    E --> ST
    E2 --> ST
    E --> SCH
    E2 --> SCH
```

---

## 4. 组件架构图

```mermaid
graph TD
    subgraph 接入层
        API[HTTP/WS API]
        MCPServ[MCP Server 预留]
    end
    subgraph 引擎层
        SOC[Socratic Engine]
        SIG[Signal Parser]
        PROF[Profile Engine]
        REF[Reflection Engine]
        RES[Resource Engine]
        VOI[Voice Engine 非实时]
        PLA[Plan+Review 引擎<br/>计划/复盘/交叉确认/锚定]
        SKE[Strategy Manager<br/>skill 拔插 + SkillGen]
        EVL[EvalGate<br/>评测回测门禁]
    end
    subgraph 适配层
        LLMP[LLM Provider 注册表]
        ASRP[ASR Provider]
        TTSP[TTS Provider]
        REMP[Reminder Provider 注册表]
        SRCP[Search Provider]
    end
    subgraph 基础设施
        SQL[(SQLite<br/>画像/反思/计划/复盘/事件/锚点)]
        FS[(本地文件 md/音频/快照)]
        RAG[(关键词检索 RAG)]
        CRON[Cron Scheduler<br/>反思+周/月评测]
    end
    API --> SOC
    API --> PROF
    API --> REF
    API --> RES
    API --> VOI
    API --> PLA
    API --> EVL
    API --> SKE
    MCPServ --> API
    SOC --> SIG
    SOC --> SKE
    SOC --> PROF
    SOC --> RAG
    SOC --> LLMP
    PLA --> PROF
    PLA --> EVL
    SKE --> EVL
    EVL --> LLMP
    RES --> SRCP
    REF --> CRON
    REF --> REMP
    LLMP -->|豆包default| LLM
    LLMP -->|独立裁判| JUDGE
    PROF --> SQL
    PLA --> SQL
    REF --> SQL
    REF --> FS
    RES --> FS
    RES --> RAG
    VOI --> ASRP
    VOI --> TTSP
```

---

## 5. 关键设计原则

1. **依赖倒置**：引擎只依赖 Provider **接口**，不依赖具体 SDK；工厂注册表集中管理与切换；LLM/裁判/ASR/TTS/Search 全部可插拔。
2. **AI 本地化边界**：预留 Python sidecar 插件口，撞墙即插，避免未来重构。
3. **实时语音隔离**：Phase 2 WebSocket 通道独立演进，不影响文本链。
4. **反思闭环须人工确认**：升级文档未确认不自动进入设计与开发。
5. **docs=唯一依据**：需求 → 设计（总体+详细） → 开发计划逐级可审查、可追溯。
6. **文档状态机**：计划/复盘/反思均为 draft→confirmed，未确认不推动下一步；生成按 id 幂等。
7. **计划↔复盘交叉确认**：复盘确认后按计划目标比对，达标主题回写画像增量（掌握度+兴趣），动态校准学习画像。
8. **锚定反思**：连续多期复盘加权分低于阈值时，自动诊断"画像锚点是否有误"并修正（LLM 优先 + 启发式降级 + 审计落盘）。
9. **组合加权进化评估**：计划/复盘两能力以可插拔策略表达；进化须经 plan+review 组合加权评测（默认各 0.5），verdict accepted 且人工确认后才应用。
10. **评测回测门禁**：新能力（skill/策略）必须过冻结线程回放 + LLM-as-Judge 打分 + 人工拦截，禁止未评估自动上线。

---

## 6. 边界与外依赖清单

| 依赖 | 是否外部 | 说明 |
|---|---|---|
| LLM（豆包默认/qwen/deepseek/EXTRA） | 外部 | OpenAI 兼容 HTTP，Provider 抽象 |
| 评测裁判模型（LLM-as-Judge） | 外部 | 可独立配置（JUDGE_PROVIDER/MODEL），默认跟随主模型 |
| ASR / TTS | 外部 | 豆包真实提供方 + Mock 兜底；Phase 2 支持流式 |
| 联网检索 | 外部 | Search Provider 可插拔 |
| Python sidecar | 预留外部 | 本地 AI 边界（SOTA 模型） |
| SQLite / 文件 / 关键词 RAG | 内部 | 本地存储（向量库预留） |

**人审要点确认**：① 业务逻辑（苏格拉底四象限 + 反思须确认 + 计划/复盘自我进化闭环）是否合理；② 组件划分（能力引擎层与基础引擎层）是否清晰；③ 边界（外部依赖最小化、Provider 可切换、评测门禁）是否可接受。

---

## 7. 版本迭代说明

### v1.0（2026-09-02）
- 初始总体设计：文本对话 + 画像/自适应 + 反思闭环 + Web + 非实时语音 + 资料引擎/RAG 基础（对应软件 0.1.0）。

### v1.1.0（2026-09-09，对应软件 0.2.0–0.4.0）
本版涉及**架构、系统边界、设计原则、主要功能流程**的变化，逐项说明：

1. **架构变化**：
   - 引擎层新增「能力与评测引擎」：`skills`（能力 skill 拔插）、`eval`（评测回测门禁 EvalGate）、`skillgen`（能力 skill 生成）、`plans`（学习计划 + 复盘，含评分/交叉确认/锚定/策略评估 10 文件）。
   - 调度层新增 `EvalScheduler`（每周抽样 + 每月全量评测，独立于每周反思调度）。
   - 语音能力落地为豆包真实 ASR/TTS 提供方（HTTP 直连），Mock 兜底全链路可跑。

2. **系统边界变化**：
   - 新增外部依赖「评测裁判模型」（LLM-as-Judge，可独立配置）。
   - 存储扩展：SQLite 新增 4 表（`study_plans` / `reviews` / `anchor_adjustments` / `learning_events`），md 产物三件套（`data/plans|reviews|anchors`），策略注册表 `data/plans/active.json`、skill 注册表 `data/skills/active.json`、评测快照 `data/evals/snapshots/`。
   - API 扩展：新增计划/复盘/策略/锚点 9 条路由（`/api/plan/*`、`/api/review/*`、`/api/strategy/*`、`/api/anchors/latest`）；前端新增「计划/复盘」tab。

3. **设计原则变化**：新增原则 6–10（文档状态机、交叉确认、锚定反思、组合加权进化评估、评测回测门禁）。

4. **主要功能流程变化**：新增「学习计划 → 学习事件积累 → 复盘加权评分 → 确认（交叉确认 + 锚定反思）→ 策略组合加权进化评估 → 应用」自我进化闭环（详见 §1 第二流程图与 §2 时序图）。
