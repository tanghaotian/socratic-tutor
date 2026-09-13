# Socratic Tutor（对话式苏格拉底教学 Agent）

> 版本：0.7.0 · 技术栈：Node.js / TypeScript

基于**苏格拉底式对话启发**的本地个人学习陪伴 Agent。核心是用**层层提问引导自主思考**，依据**回答质量与学习频率自适应调整教学方案**，并具备**每周自我反思升级**与**书籍/论文/视频总结检索**能力。

## 核心机制

1. **对话启发式**：开放式提问 → 聚焦追问 → 认知冲突 → 自我评估 → 适时提示；支持语音对话（Phase 1 非实时，Phase 2 实时可打断，交互参照豆包）。
2. **吾日三省吾身**：每周五 19:00（可配置）定时自我检索，生成《升级需求文档》；经用户确认后才进入设计 → 开发计划 → 更新。
3. **资料总结检索**：联网检索、书籍/论文/视频结构化总结、book-to-skill 整理生成 md 到本地 `knowledge/skills/`。
4. **学习计划 + 复盘阶段**：按主题生成学习计划 md（目标/深度/会话数）→ 周期结束生成复盘 md（四维加权评分）；复盘确认时与计划**交叉确认**动态更新画像，**连续多期加权分不理想**自动触发**锚定反思**（LLM/启发式修正画像锚点 + 审计落盘）；两阶段生成能力可**组合加权评测**（plan+review 联合打分 A/B）进化，达标才应用。

## 架构概览

```
表现层(Web UI / IDE Agent) → API(HTTP/WS/MCP) → 应用层(教学/画像/反思/资料引擎)
   → 适配层(LLM/ASR/TTS/Reminder Provider) → 基础设施(存储/RAG/调度器)
```

- **模型可切换（配置化注册）**：LLM Provider 抽象，单一 OpenAI 兼容注册清单 `config.llm.models`。内置豆包/DeepSeek/qwen（`LLM_PROVIDER=qwen` 即用 `qwen3.7-flash`）；追加任意 OpenAI 兼容模型只需在 `LLM_EXTRA_MODELS` 加一项 JSON，**零代码接入**。
- **独立评测 judge**：评测量小，可用 `JUDGE_PROVIDER`/`JUDGE_MODEL` 指定更强的模型做 LLM-as-Judge（默认跟随主模型）。
- **可部署 + IDE 集成**：本地 Web 服务优先，预留容器化部署；**MCP Server（0.7.0 已完成）** 经 `POST /mcp`（HTTP JSON-RPC）向 IDE（优先 TRAE，Claude Code 扩展）暴露与页面一致的能力：`chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate`。
- **AI 本地化边界**：预留 Python sidecar 插件口，避免未来本地模型重构。
- **横扩 + 流量回放录制（0.6.0 已完成）**：Web 无状态可横扩；定时任务（反思/评测）经**分布式锁**（进程内/file/SQLite 三种后端）防多实例重复执行；可插拔录制层把每次真实对话/语音录制为冻结线程（`data/threads/`）并抽样维护黄金数据集，供回放评测（MVP 不引 Kafka）。

## 目录结构

```
docs/              需求(requirements)、设计(design/overall,detail,debate)、开发计划、反思产物
knowledge/skills/  book-to-skill 产物 md（本地知识源）
src/               web / engines / providers / storage / scheduler / mcp
public/            前端
data/              SQLite、画像、反思、音频（运行时）
scripts/           dev / build / 语音自检 / 种子线程 脚本
```

## 安装与运行

```bash
npm install                  # 安装依赖
npm test                     # 运行单元测试
cp .env.example .env         # 配置 DOUBAO_API_KEY、LLM_PROVIDER 等
npm run dev                  # 启动本地 Web 服务
```

**辅助命令**（均需先 `npm run build`）：

```bash
npm run seed:threads         # 写入内置教学种子线程到 data/threads/（评测冷启动，幂等）
npm run voice:verify         # 语音链路自检（TTS→ASR 闭环；未配凭据时提示 Mock 模式）
```

详细开发命令见 `scripts/dev.ps1` / `scripts/dev.sh`。

> **真实数据回填**：`data/threads/` 的种子线程为人工编写的教学样例，仅用于让评测链路开箱可跑。
> 接入真实使用后由录制层自动累积真实对话，种子文件可随时删除；评测阈值与抽样规模需按真实数据复核。

**开发进度**：IT1-IT8（Phase 1，0.1.0）✅ · **Phase 1.5（0.2.0）** ✅ IT9 引擎 skill 拔插（教学/画像引擎经 StrategyManager 消费可插拔 skill，含叠加/启停/快照）· IT10 自建评测回测门禁（快照基线 + rubric LLM-as-Judge + A/B 胜率，每周抽样/每月全量，从 `data/threads` 读冻结线程、`data/evals` 读快照并写报告，统一 EvalManager 接口可切换 promptfoo/agentbench/deepeval；报告落盘 `data/evals/<日期>_<引擎>_<周/月>.json`，verdict 需人工拦截) ✅ · **IT10b 能力 skill 生成链路（§8.2.1）✅**（把 book-to-skill 知识 md 判定为教学/教育方法论类 → LLM 提炼规则 → 生成纯 TS 能力 skill 草案 + 说明文档，注册到评测门禁工厂并跑 runEvalGate 出 verdict；反思流程可经 `skillGen` 选项扫描 `knowledge/skills/` 并把草案并入报告）✅ · **应用步骤 ✅**（`applyGeneratedSkill` 把经人工拦截确认的草案持久化到 `data/skills/active.json`；引擎经 `createEngineManagerFromRegistry` 装配，启动时把已应用 skill 叠加到默认 core 组合上）✅ · **IT10c when-to-use 使用场景 + 组合编排（0.3.0）✅**（每个 skill 经 `SkillWhen` 声明何时/何场景才被引用——concepts/signals/consecutive/profileMasteryLt，由 `StrategyManager.run` 按 when 门控激活；同 `exclusiveGroup` 的多个 skill 经 `canHandle` 竞合择优，组合引用多个 skill 时仅最优者执行；生成产物内嵌 when，`docs/skills/*.md` 增"使用场景（when-to-use）"段）· **IT12 Provider 切换 + 独立评测 judge ✅**（LLM Provider 配置化自动注册（`config.llm.models` 单一事实来源，可经 `LLM_EXTRA_MODELS` 零代码追加任意 OpenAI 兼容模型）；`JUDGE_PROVIDER`/`JUDGE_MODEL` 可让周报/月报评测用独立更强 judge，未配则跟随主模型）· **IT13 0.3.0 收尾 + 真实闭环验证 ✅（2026-09-09）**（版本统一 0.3.0——package.json/lock 两处/启动打印/README 中英；git init + `.gitignore`（`.env`/`data` 不入库）；配置真实 qwen key 后全链路走真实 LLM：对话信号判定与文案、每周反思导出、`skillGen` 分类+规则提炼均真实调用；评测门禁用真实裁判打分（`judgeDegraded=false`）。由 `knowledge/skills/feynman-technique.md` 生成费曼学习法 skill，verdict **accepted**（rubric 各维 +0.5、A/B 3:0、candidate 均分 9.1），经人工拦截应用至 `data/skills/active.json`，引擎装配启动时自动叠加于 `socratic.core` 之上）· **IT14 0.4.0 学习计划 + 复盘阶段 ✅（2026-09-09）**（新增 `src/engines/plans/`：StudyPlanEngine 按主题生成学习计划 md（draft→confirmed）；ReviewEngine 周期末按四维加权评分生成复盘 md，confirm 触发**交叉确认**（达标主题抬升画像掌握度/兴趣）与**锚定反思**（连续 `PLAN_ANCHOR_STREAK` 次加权分 < 阈值自动修正画像锚点，LLM 优先 + 启发式降级，审计落 SQLite + `data/anchors/<reviewId>.md`）；`eval.ts` 组合加权评测门禁（plan/review 两维 LLM-as-Judge + 加权合成 A/B，verdict accepted 才写 `data/plans/active.json` 注册表，装配时叠加默认策略）；Web 新增 `/api/plan/*`、`/api/review/*`、`/api/strategy/*` 路由 + 前端「计划/复盘」tab；对话/语音自动记录学习事件供评分。测试（测试 88 例全过，`npm run build` 通过）· **IT15 0.5.0 向量 RAG ✅（2026-09-09）**（sqlite-vec + Node 24 `node:sqlite` 语义检索；`RAG_BACKEND=hybrid` 向量 KNN + 关键词兜底，embedding 复用主 LLM，未配 `EMBEDDING_MODEL` 自动降级；接入 `/api/resource/search`；测试 95 例全过）· **IT16 0.6.0 多节点 + 流量回放录制 ✅（2026-09-10）**（新增 `src/tracing/`：`ReplayRecorder` 把每次对话/语音录制为冻结线程落盘 `data/threads/`（幂等），`sampleThreads` 分层抽样——按主题分层 + 失败优先 + 语义去重（缺 embedding 退化为 id 去重），`GoldenDataset` 维护黄金数据集且可被 `loadFrozenThreads` 直接读取；新增 `src/locks/` 分布式锁（进程内/file/SQLite 三后端）包裹反思/评测定时任务，多实例并发仅一个执行；录制为可插拔中间件默认开，MVP 不引 Kafka。测试 105 例全过，`npm run build` 通过）· **IT17 0.7.0 MCP Server ✅（2026-09-10）**（新增 `src/mcp/`：共享 `McpContext` 复用 Web 装配的同批引擎/存储/provider；在既有 Fastify 上挂载 `POST /mcp`，实现 MCP JSON-RPC 2.0——`tools/list` 返回 `{ tools: [...] }`（7 个工具，`inputSchema` 为 strict schema 且 `additionalProperties:false`）、`tools/call` 分发 `chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate`，语义与 Web API 一致，错误按标准码返回（MethodNotFound/InvalidParams 等）；`MCP_ENABLED=false` 时不注册 `/mcp`、不影响 Web 服务。测试 120 例全过，`npm run build` 通过）。

## 开发计划

- **Phase 1（目标 0.1.0）**：文本苏格拉底对话 + 学习画像/自适应 + 反思闭环 + Web 界面 + 非实时语音 + 资料引擎/基础 RAG
- **Phase 1.5（目标 0.2.0）**：引擎 skill 拔插（教学/画像引擎可增加/调整多 skill）+ 自建评测回测门禁（快照基线 + rubric 打分 + A/B 胜率，每周抽样/每月全量，人工拦截；统一评测接口可切换框架）
- **Phase 1.6（目标 0.4.0）**：学习计划 + 复盘阶段（计划/复盘 md + 交叉确认 + 加权锚定反思 + 组合加权进化评估）✅
- **0.5.0（已完成）**：向量 RAG / 语义检索——sqlite-vec（零新基建，关键词检索保留为降级后端）✅
- **0.6.0（已完成）**：多节点部署 + 生产流量回放录制——Web 无状态横扩 + SQLite 主/副本 + 定时任务分布式锁 + 可插拔录制层（MVP 不引 Kafka）✅
- **0.7.0（已完成）**：MCP Server——经 `POST /mcp`（HTTP JSON-RPC，共享 `src/mcp`）暴露 `chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate` ✅
- **Phase 2**：实时双向语音 + 容器化部署
- **Phase 3**：提醒通道扩展（QQ 邮箱 / 微信）+ RAG 优化

详见 [docs/development-plan.md](docs/development-plan.md)。