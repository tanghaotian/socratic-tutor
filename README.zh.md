# Socratic Tutor（对话式苏格拉底教学 Agent）

[English](README.md) | 中文

一个自托管的个人学习陪伴服务，教学方式是**提问而非给答案**。它以本地 Web 服务形式运行，维护一份学习
画像，并根据你的实际回答质量自适应调整教学方案。

核心机制是苏格拉底式对话：开放式提问 → 聚焦追问 → 认知冲突 → 自我评估 → 适时提示。你的每次回答会被判定为
一个信号（`correct` / `confused` / `mistake` / `divergent`），该信号用于更新画像并决定下一个问题。项目还
带有一套自我评估闭环：它会周期性审视自己的教学质量并提出升级建议，而这些建议**只有经你确认后才会生效**。

- **版本**：0.7.0
- **技术栈**：Node.js 22+ / TypeScript、Fastify、SQLite（内置 `node:sqlite`）、单文件 Vue 3 前端
- **定位**：个人/本地使用。单用户（`local-user`），无多租户鉴权，尚无容器镜像。

正式使用前请先阅读[已知限制](#已知限制)——其中若干部分是如实标注的脚手架，而非已完成功能。

## 功能

- **自适应苏格拉底对话**——回答信号驱动题型、深度与提示层级。
- **学习画像与自适应**——掌握度、错误/强项、兴趣权重、学习速度。
- **学习计划 + 复盘阶段**——按主题生成计划 md → 周期末生成含四维加权评分的复盘 md → 交叉确认更新画像；
  连续低分自动触发**锚定反思**。
- **每周自我反思**——定时任务生成《升级需求文档》，等待你确认。
- **资料引擎**——书籍/论文/视频的结构化总结、`book-to-skill` 生成 md 落到 `knowledge/skills/`，并对该
  本地知识库做检索（关键词，或接入 embedding 的混合检索）。
- **语音（Phase 1，非实时）**——上传录音 → ASR → 对话 → TTS。未配置凭据时回退 Mock，并会**显式告知**。
- **MCP Server**——经 `POST /mcp` 以 Streamable HTTP 向 MCP 客户端（IDE Agent）暴露同一套能力。
- **评测门禁**——冻结线程回放 + rubric LLM-as-Judge + A/B 胜率，任何 skill/策略变更都要同时通过机器裁定
  **与**人工确认。

## 架构

```
表现层（Web UI / MCP 客户端）
  → API（Fastify REST / MCP over HTTP JSON-RPC）
    → 引擎层（教学 · 画像 · 反思 · 资料 · 计划复盘 · skillgen · 评测）
      → 适配层（LLM · ASR · TTS · 检索 · 提醒）
        → 基础设施（SQLite · RAG/向量 · 调度器 · 分布式锁 · 录制层）
```

比分层图更重要的两个设计决定：

- **引擎 skill 可拔插。** 教学与画像引擎经 `StrategyManager` 消费 `CapabilitySkill` 模块（叠加、启停、
  快照、`when` 门控、互斥组竞合）。默认的 `socratic.core` 保证旧行为不回归，生成的 skill 叠加在其上。
- **模型无关。** 单一 OpenAI 兼容注册清单（`config.llm.models`）覆盖豆包、DeepSeek、Qwen；任何其他兼容
  端点只需在 `LLM_EXTRA_MODELS` 加一项 JSON——**零代码改动**。

## 快速开始

**前置要求**：Node.js **22 或更高**（存储层使用 Node 内置 `node:sqlite` 模块；Node 18 不满足，尽管 0.7.0
之前 `package.json` 如此声明——现已将声明的引擎版本对齐到 22）。

```sh
git clone git@github.com:tanghaotian/socratic-tutor.git
cd socratic-tutor
npm install
cp .env.example .env
npm run dev
```

`cp .env.example .env` 复制配置模板，随后由你填入 API key（见[配置](#配置)）。`npm run dev` 会在
`http://127.0.0.1:5173` 启动 Web 服务。

如需运行编译产物：

```sh
npm run build
npm start
```

`npm run dev` 经 `tsx` 以 watch 模式直接运行 TypeScript；`npm run build` 用 `tsc` 编译，`npm start` 运行
编译产物。

### 上手试用

1. 打开 `http://127.0.0.1:5173`。
2. 在**对话**标签填入主题（如 `微积分`）并回答问题——简短或迟疑的回答会被判为 `confused`；连续两次会从
   聚焦追问升级为提示。
3. 查看**学习画像**，看对话积累出的画像。
4. 在**计划/复盘**标签生成计划、确认后生成复盘。

## 配置

全部配置均为环境变量，从 `.env` 读取（不入库）。关键项：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LLM_PROVIDER` | `doubao` | 当前模型 id；取内置的 `doubao` / `deepseek` / `qwen`，或 `LLM_EXTRA_MODELS` 中的任意 id。 |
| `QWEN_API_KEY` | — | Qwen（DashScope 兼容）端点的 key。 |
| `DOUBAO_API_KEY` | — | 豆包（火山方舟）端点的 key。 |
| `DEEPSEEK_API_KEY` | — | DeepSeek 端点的 key。 |
| `LLM_EXTRA_MODELS` | — | JSON 数组 `{id, baseURL, apiKey, model}`，零代码接入任意 OpenAI 兼容模型。 |
| `JUDGE_PROVIDER` / `JUDGE_MODEL` | 跟随主模型 | 仅用于评测裁判的更强模型。 |
| `PORT` | `5173` | Web 服务端口（绑定 `127.0.0.1`）。 |
| `STORAGE_DIR` | `./data` | SQLite 库、计划、复盘、反思、音频。 |
| `KNOWLEDGE_DIR` | `./knowledge/skills` | `book-to-skill` 产物 md 与 RAG 源。 |
| `RAG_BACKEND` | `keyword` | `keyword`，或语义检索的 `hybrid`（还需配 `EMBEDDING_MODEL`）。 |
| `CONVERSATION_MAX_HISTORY` | `20` | 参与连续信号判定的历史轮数（设有上限以约束 token 增长）。 |
| `MCP_ENABLED` | `true` | 是否在 `/mcp` 注册 MCP 端点。 |
| `REFLECTION_CRON` | `0 19 * * 5` | 每周自我反思调度（周五 19:00）。 |
| `TRACING_ENABLED` | `true` | 是否把真实对话录制为冻结线程，供回放评测使用。 |

完整清单见 [`.env.example`](.env.example)（含语音、计划/复盘权重、评测周期、多节点部署、分布式锁）。

> **未配置时语音为 Mock。** 缺少 `ASR_APPID` / `ASR_ACCESS_TOKEN` / `TTS_APPID` / `TTS_ACCESS_TOKEN` 时，
> ASR 返回占位文本、TTS 返回静音。服务会在启动时打印告警，且 `/api/voice/chat` 返回
> `voiceDegraded: true`——**绝不静默伪装成真实识别**。

## MCP 集成

MCP Server 挂载在与 Web 服务相同的端口上（Streamable HTTP，协议 `2025-06-18`，`MCP_ENABLED=false` 可
关闭）。已按规范实现握手、版本协商、`Mcp-Session-Id` 会话、`ping`、`DELETE` 与 Origin 校验。

暴露 7 个工具：

| 工具 | 用途 |
| --- | --- |
| `chat_socratic` | 一轮苏格拉底对话：判定信号 → 更新画像 → 返回教学动作。 |
| `get_learner_profile` | 读取学习画像（可按主题查看）。 |
| `trigger_reflection` | 生成每周升级文档（草案）。 |
| `confirm_upgrade` | 确认反思草案。 |
| `summarize_resource` | 对书籍/论文/视频做结构化总结并写入 `knowledge/skills/`。 |
| `plan_generate` | 为指定主题生成学习计划草案。 |
| `review_generate` | 生成含四维加权评分的复盘草案。 |

读类工具可直接调用。**会改变状态的工具（`confirm_upgrade`）保留人工确认为必经步骤**——这条界线是刻意
设计，而非偶然结果。

## 开发

```sh
npm run dev
npm run build
npm start
npm test
npx tsc --noEmit
```

`npm test` 运行 `test/` 下的 `node:test` 测试套件；`npx tsc --noEmit` 仅做类型检查、不产出文件。

辅助脚本（均需先 `npm run build`）：

```sh
npm run seed:threads
npm run voice:verify
npm run verify:bug004
npm run assess:sample
```

`seed:threads` 把内置教学种子线程写入 `data/threads/`（幂等），`voice:verify` 检查 TTS→ASR 闭环、未配
凭据时提示 Mock 模式，`verify:bug004` 对会话历史行为做进程内断言，`assess:sample` 是评测样本就绪度门禁
（真实数据不足时以退出码 `1` 结束）。

`assess:sample` 存在的原因：评测阈值最初仅经三条冻结线程校准，而设计目标是每周抽样 20–30 条。该脚本把
**真实**线程与人工种子线程（`t-seed-*`）分开统计，并在真实数据不足时以非零码退出——种子数据绝不能用于
阈值校准，否则会得出虚假通过的结论。

### 项目结构

```
src/
  web/          Fastify REST 路由 + 静态前端托管
  mcp/          MCP Server（Streamable HTTP、JSON-RPC、工具注册表）
  engines/      socratic · profile · reflection · resource · plans · skills · skillgen · eval
  providers/    LLM（OpenAI 兼容）· ASR · TTS · 检索 · 提醒
  storage/      SQLite（画像、计划、复盘、会话、学习事件）· RAG · 向量
  scheduler/    每周反思 + 每周/每月评测定时任务
  locks/        分布式锁（进程内 · 文件 · SQLite）
  tracing/      录制、抽样、黄金数据集、回放
public/         单文件 Vue 3 前端
test/           node:test 测试套件
docs/           需求、设计、开发计划、评估记录
knowledge/skills/   book-to-skill 产物（运行时知识源）
data/           运行时状态——SQLite、计划、复盘、音频、线程（不入库）
```

### 测试说明

测试使用内置 `node:test` 运行器。路由行为经 Fastify 的 `app.inject()` 覆盖，而非直接调用 handler——
v0.7.0 曾出现 `POST /mcp` 返回 `{}` 而所有函数级测试全部通过的情况，因此新增路由**必须**配备端点级断言。

## 评测与自我进化

项目把「这次改动是否真的更好」当作可测量的问题，而不是审美问题：

1. 真实对话被录制为**冻结线程**（`data/threads/`）。
2. 一项改动被描述为候选**快照**（激活的 skill 组合 / 策略配置）。
3. 基线与候选在同一批线程上回放，由 LLM 裁判按 rubric 打分，并给出 A/B 胜率
   （`data/evals/<日期>_<引擎>_<周/月>.json`）。
4. 裁定结果（`accepted` / `rejected` / `needs_review`）仅为建议——**应用它是一步人工操作**。

生成的能力 skill 走同一条路径：知识 md → LLM 规则提炼 → 生成 TypeScript skill 草案 → 评测门禁 →
人工确认 → `data/skills/active.json`。

## 已知限制

以下问题会影响项目对你是否可用，故如实列出：

- **评测样本量不足。** 阈值是在极少量真实数据上验证的。运行 `npm run assess:sample` 查看当前状态。
- **录制线程为单轮。** 录制层保存的是一组 user/agent，因此冻结线程在回放时不覆盖连续信号逻辑。
- **语音未端到端验证**（默认 Mock 模式，需真实 ASR/TTS 凭据）。
- **单用户、无鉴权。** `learnerId` 硬编码为 `local-user`，没有登录或租户隔离。
- **无容器镜像。** 容器化部署为规划项，尚未构建。
- **尚无许可证文件。** 仓库当前未声明许可证；在补充之前，请视为保留所有权利。

## 开发计划

- **0.1.0**——文本对话、画像/自适应、反思闭环、Web 界面、非实时语音、基础 RAG
- **0.2.0**——引擎 skill 拔插、自建评测回测门禁
- **0.3.0**——when-to-use 门控、skill 组合竞合、Provider 切换、独立评测 judge
- **0.4.0**——学习计划 + 复盘阶段、交叉确认、锚定反思、组合加权进化
- **0.5.0**——向量 RAG / 语义检索（`sqlite-vec`）
- **0.6.0**——多节点部署、分布式锁、流量回放录制
- **0.7.0**——MCP Server（Streamable HTTP）
- **后续**——实时双向语音、容器化部署、提醒通道扩展、RAG 优化

完整计划与逐迭代记录见 [docs/development-plan.md](docs/development-plan.md)；把编排层改为 LLM 驱动 agent
loop 的成本/收益评估见 [docs/design/agentification-assessment.md](docs/design/agentification-assessment.md)。
