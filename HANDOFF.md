# HANDOFF.md

> 更新于：2026-09-13（交付验收复核实测：修复 BUG-002 MCP 端点对外不可用；测试 121 例全过）

## 当前进度

- 需求/设计/开发计划文档全部完成（多架构师辩论收敛，OQ 已全部定案）。

- **IT1 完成**：工程初始化 + LLM Provider 抽象（doubao/deepseek 适配器 + 注册表 + web reminder）。`npm run build` 通过，应用可正常启动。

- **IT2 完成**：教学引擎（Socratic + Signal）。`SignalParser.parse`（structuredCall 四类信号 + 规则兜底）+ `SocraticEngine.generateAction`（确定性题型路由 + LLM 文案）。`npm test` 7 例全过。详见 development-plan IT2 实现备注。

- **IT3 完成**：学习画像/自适应（ProfileEngine + SqliteStorage，`node:sqlite` 零原生依赖）。`npm test` 共 12 例全过（含持久化回读冒烟）。`toAdaptiveView` 已接入 IT2 契约。

- **IT4 完成**：反思闭环（ReflectionEngine + Scheduler(node-cron)）。按日期幂等生成 draft、SQLite 持久化、`data/reflections/<date>.md` 导出、Web 提醒、`confirm` 仅 draft→confirmed。`npm test` 共 16 例全过。

- **IT5 完成**：Web 服务与界面。Fastify REST + 静态托管 Vue3 `public/index.html`。依赖新增 fastify、@fastify/static。

- **IT6 完成**：非实时语音。ASR/TTS Provider（豆包+Mock 占位）+ `runVoiceTurn` 引擎 + `AudioStore` + `POST /api/voice/chat`（multipart）+ `/audio/*` 静态 + 前端录音/播放。无 key 时 Mock 全链路可跑通。依赖新增 @fastify/multipart。`npm test` 共 18 例全过。

- **IT7 完成**：资料引擎。`ResourceEngine`（summarize/bookToSkill/searchWeb/queryRag）+ `RAGStore` 轻量关键词检索（不引向量库）+ `MockSearchProvider` + `POST /api/resource/summarize`、`POST /api/resource/search`。产物写入 `knowledge/skills/<slug>.md` 并刷新 RAG。`npm test` 共 22 例全过。

- **IT8 完成**：项目管理产物。README（中英）进度同步至 IT7、版本 0.1.0（去掉"规划中"）；scripts `{dev,build}.{ps1,sh}` 薄封装可运行（build.ps1 EXIT=0；dev.ps1 可启动至 `npm run dev`）；版本三处一致 0.1.0。**Phase 1（0.1.0）全部落地**。

- **IT9 完成**：引擎 skill 拔插。`src/engines/skills/`（types/manager/socratic.core/socratic.interest/profile.core/index）。教学与画像引擎只经 `StrategyManager.run` 消费可插拔 skill（register 替换、enable/disable、list、snapshot、按序叠加并注入 prevAction 改写）。默认激活 core 保证旧行为回归；`profile.core` 产出 ProfileDelta 由引擎合并落库。`updateFromSignal` 改 async（web 两处调用补 await）。`npm test` 共 31 例全过。

- **IT10 完成**：评测回测门禁。`src/engines/eval/`（types/manager/backends.selfbuilt,adapters/index）+ `reflection-gate.ts` + `scheduler/eval-cron.ts` + `config`（eval 段）+ `index.ts` 挂载调度。自建后端逐线程 baseline/candidate 快照重放 + LLM-as-Judge rubric 打分 + A/B 裁定（judge 失败降级启发式并标记 `judgeDegraded`）；判定：核心维回退→rejected、均分≥6 且加权 delta>0→accepted、否则 needs_review（人工拦截）。外部框架（promptfoo/agentbench/deepeval）占位后端可注册切换。每周（`0 20 * * 5`）/每月（`0 9 1 * *`）从 `data/evals/snapshots/` 读快照、`data/threads/` 读冻结线程出周报/月报，报告落盘 `data/evals/<date>_<engine>_<kind>.json`；`registerSkillFactory` 供未来生成 skill 接入回测。`npm test` 共 39 例全过。

- **IT10b 完成**：能力 skill 生成链路（§8.2.1）+ **应用步骤**。`src/engines/skillgen/index.ts`——`classifyMethodology`（LLM 判定失败降级启发式）、`extractRules`（提炼 purpose/strategy/triggers/phrase/interestBoost）、`buildSkillCode`（生成纯 TS CapabilitySkill，确定性 apply）、`createSkillFromRules`（运行时等价）、`generateFromKnowledge`（判定→提炼→生成→写盘+ `docs/skills/<id>.md`）、`registerGeneratedSkill`（注册评测门禁工厂）、`runSkillGenPipeline`（判→生成→注册→跑 EvalGate 出 verdict 供人工拦截）、`scanKnowledgeDirForSkills`。**应用**：`applyGeneratedSkill`（持久化 `data/skills/active.json` + 注册工厂，幂等同 id 覆盖）、`listAppliedSkills`/`removeAppliedSkill`、`createEngineManagerFromRegistry`（默认 core 组合 + 已应用 skill 叠加；`web/index.ts` 已将 socratic/profile 引擎改为经它装配）。接反思：`ReflectionReport.skillDrafts` + `ReflectionEngineOptions.skillGen`（run 可选扫描 knowledge/skills 记录草案，默认不写盘），`sqlite.exportReflectionMarkdown` 增"能力 skill 草案"段落。`npm test` 共 52 例全过，`npm run build` 通过。**§8.2.1 全链路闭环：知识 md → 判定 → 提炼 → 生成草案 → 评测 verdict → 人工拦截 → applyGeneratedSkill 应用 → 引擎装配自动启用。Phase 1.5（0.2.0）核心能力（IT9/IT10/IT10b）全部落地**。

- **IT12 完成（LLM Provider 切换 + 独立评测 judge，0.2.x）**：新增 `src/providers/llm/openai-compat.ts`（通用 OpenAI `/v1/chat/completions` 兼容 Provider：chat/streamChat/structuredCall，构造校验缺 key/model 抛错）。**配置化自动注册（单一事实来源 `config.llm.models`）**：config 取消 doubao/deepseek/qwen 具名块改 `models` 数组（内置三项独立 env，可经 `LLM_EXTRA_MODELS` JSON 追加任意 OpenAI 兼容模型零代码接入）；删除语义重复的 `doubao.ts`/`deepseek.ts`，`providers/index.ts` 改导出 `OpenAICompatProvider` 与 `LLMRegistry`/`LLMProviderId`。`getJudge()` 按 id 查 `models`（judge.model 显式则以覆盖 model 重建并缓存，否则跟随主）供周报/月报评测用独立更强 judge；`ProviderContainer.getJudge()` 代理，EvalScheduler 改传 `providers.getJudge()`。`.env.example` 补 QWEN/LLM_EXTRA_MODELS/JUDGE 说明。新增 `test/providers.test.ts` 7 例。`npm test` 59 例全过、`npm run build` 通过。

- **IT13 完成（0.3.0 收尾 + 真实闭环验证，2026-09-09）**：版本统一 0.3.0（package.json / package-lock.json 两处 / src/index.ts 打印 / README 中英）；git init + `.gitignore`（`.env`、`data/`、`node_modules/`、`dist/` 不入库）。配置真实 qwen key（`LLM_PROVIDER=qwen` / `QWEN_MODEL=qwen3.7-flash`）后全链路真实验证通过：`POST /api/chat` 真实信号判定+文案（confused→focus）、`POST /api/reflect` 真实反思导出、skillGen 真实分类+提炼生成合法 TS（费曼学习法）、EvalGate 真实裁判打分（`judgeDegraded=false`，各维 +0.5、A/B 3:0、candidate 均分 9.1 → verdict **accepted**，周报 `data/evals/2026-09-09_socratic_weekly.json`）。经人工拦截应用 `socratic.feynman` 至 `data/skills/active.json`，引擎装配 = `["socratic.core","socratic.feynman"]`。OQ-7 阈值经首轮真实数据验证**无需调整**（3 条样本，待真实数据积累后复核抽样规模）。`npm test` 62 例全过、`npm run build` 通过。

- **IT14 完成（0.4.0 学习计划阶段 + 复盘阶段，2026-09-09）**：新增 `src/engines/plans/`（10 文件 + index barrel）——`StudyPlanEngine` 按主题生成学习计划 md（目标/深度/会话数/锚点快照，draft→confirmed，幂等）；`ReviewEngine` 计划周期末按**四维加权评分**（目标完成率 0.4/信号正确率 0.2/频率达成率 0.2/掌握度变化 0.2，可配且归一化）生成复盘 md，confirm 触发**交叉确认**（达标主题抬升画像掌握度+兴趣）与**锚定反思**（连续 `PLAN_ANCHOR_STREAK` 次加权分 < 阈值自动修正锚点，LLM 优先+启发式降级，审计 SQLite + `data/anchors/<reviewId>.md`）；`eval.ts` **组合加权评测门禁**（plan/review 两维 LLM-as-Judge × 0.5/0.5 合成 A/B，accepted 才写 `data/plans/active.json`，装配叠加默认策略）。SQLite 4 张新表 + export md 三件套；Web 9 条新路由（`/api/plan/*`、`/api/review/*`、`/api/strategy/*`、`/api/anchors/latest`）+ 前端「计划/复盘」tab；对话/语音自动记录学习事件。`npm test` **88 例全过**（新增 26 例）、`npm run build` 通过、版本统一 0.4.0。

- **IT15 完成（0.5.0 向量 RAG / 语义检索，2026-09-09）**：新增 `src/providers/llm/embeddings.ts`（EmbeddingProvider + OpenAICompatEmbedding + HashEmbeddingProvider 本地确定性嵌入）与 `src/storage/vec.ts`（VectorStore，sqlite-vec + Node 24 `node:sqlite` `allowExtension:true` 加载扩展）。`RAGStore` 构造支持 `{ embedding?, backend }`：`reload()` 异步重建向量索引、新增 `ensureVectors()` / `searchHybrid()`（**向量语义 KNN + 关键词兜底**，未配 embedding 自动降级纯关键词）。`ResourceEngine.queryRagHybrid()` 接入 `/api/resource/search`（返回 `backend` 字段）；配置新增 `RAG_BACKEND`（keyword|hybrid，默认 keyword）/`EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`，`getEmbedding()` 复用主 LLM 连接、未配 model 返回 null。新增 `test/vec.test.ts` **6 例**：AC-1 sqlite-vec 加载建表 KNN、AC-2 语义相关（无共同关键词）命中、AC-3 keyword 后端回归纯关键词、AC-4 reload 后向量索引同步。`npm test` **95 例全过**、`npm run build` 通过、版本统一 0.5.0。

- **IT16 完成（0.6.0 多节点 + 流量回放录制，2026-09-10）**：新增 `src/tracing/`（`replay.ts` 录制中间件 `ReplayRecorder` + `buildThreadId` 幂等安全；`sample.ts` 分层抽样 `sampleThreads`（按 topic 分层 + 失败优先预算 + 语义去重，缺 embedding 退化为 id 去重）；`golden.ts` 黄金数据集 `GoldenDataset`（增量抽样 audit + 幂等 add，输出 FrozenThread[] 可被 `loadFrozenThreads` 直接读）。新增 `src/locks/`（`createDistributedLock` 三后端 single/file/db + `withLock`）。`scheduler/index.ts`/`eval-cron.ts` 定时任务包分布式锁防多实例重复执行；`web/index.ts` 在 `/api/chat` 与 `/api/voice/chat` 完成一轮后自动录制（`cfg.tracing.enabled` 默认开，失败静默）。config/env 新增 `tracing.*` 与 `deploy.*` 段。新增 `test/{replay,sample,lock}.test.ts` **10 例**。`npm test` **105 例全过**、`npm run build` 通过、版本统一 0.6.0。

- **IT17 完成（0.7.0 MCP Server，2026-09-10）**：新增 `src/mcp/`（`context.ts` 共享 `McpContext`——与 Web 装配复用同批引擎/存储/provider；`types.ts` JSON-RPC 2.0 结构 + `JsonRpcError` 错误码；`tools.ts` 7 工具注册表 `MCP_TOOLS` + `listTools()`/`hasTool()`/`callTool()`；`index.ts` `handleJsonRpc()` 分发 + `registerMcpServer()` 在 Fastify 挂载 `POST /mcp`）。7 个工具：`chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate`，语义与 Web API 一致（复用同一存储）。`web/index.ts` 装配 `mcpCtx` 并挂载；config/.env 新增 `mcp.{enabled,transport}` 与 `MCP_ENABLED`/`MCP_TRANSPORT`（`MCP_ENABLED=false` 不注册 `/mcp`）。新增 `test/mcp.test.ts` **15 例**（AC1 7 工具/AC2 语义+存储复用/AC3 错误码/AC4 开关）。`npm test` **120 例全过**、`npm run build` 通过、版本统一 0.7.0。

## 最近完成的变更

- **BUG-002 修复（2026-09-13，交付验收复核实测发现）**：`POST /mcp` 此前**恒返回 `{}`（200）**，MCP 端点对外完全不可用（IDE/MCP 客户端无法集成）。根因：`src/mcp/index.ts` 路由 handler 中 `const res = handleJsonRpc(...)` 既未 `await` 也未 `return`，而 `handleJsonRpc` 是 async，Fastify 5 拿到未决 Promise 并序列化成 `{}`。**为何 120 例测试未拦住**：所有 MCP 用例都直接调用 `handleJsonRpc()`（函数级正确 ≠ 端点可用），AC4 用手写桩 `fakeApp` 只断言"注册了 `/mcp` 字符串"，且**全仓库从未使用 `app.inject()` 走过 HTTP 边界**。修复：handler 改 `await` + `return reply.code(200).send(res)`；`test/mcp.test.ts` AC4 两条重写为真实 Fastify 实例 + `app.inject()`（禁用时断言 404），并新增 HTTP 层回归用例（`tools/list` 非 `{}`、`tools/call` 返回真实画像、错误码经 HTTP 正确透出）。验证：`npm test` **121 例全过**（原 120）、`npm run build` 通过、**真实 HTTP 实测** `tools/list` 返回 7 个工具、`get_learner_profile` 返回 `learnerId=local-user`、未知工具返回 `-32601`。**纪律**：新增路由能力必须至少有一条经 `app.inject()` 的端点级用例。

- **验收复核实测结论（2026-09-13）**：版本 0.7.0 四处一致（package.json / package-lock 两处 / `src/index.ts` 打印 / README 中英）；`tsc --noEmit` EXIT=0；实跑 `dist/index.js` 正常启动并挂载 7 tools；`GET /` 200（静态前端）；`/api/strategy/active` 正常返回已应用策略。**注意**：实际监听端口为 **5173**（`PORT` 可覆盖），仓库根 `server.log` 记录的是 v0.3.0 时代的 **3456**，属陈旧残留、勿作为依据。

- 建立项目结构 `d:\Projects\socratic-tutor`，`knowledge/skills/` 已建。

- 文档产物：

  - `docs/requirements.md`（用户故事/操作流程/UI/选型，用户已确认）

  - `docs/design/socratic-tutor_overall-design.md`（四图总体设计，v1.1.0）

  - `docs/design/socratic-tutor_detail-design.md`（详细设计 v1.1.0，含 §8 引擎 skill 拔插 + §9 评测回测模块 + §1.5/§5.5–5.9 学习计划与复盘）

  - `docs/design/debate/question.md`、`synthesis.md`（技术栈辩论，结论：Node/TS 单体 + Provider 抽象 + Python sidecar 边界）

  - `docs/development-plan.md`（自包含任务 IT1-IT8 + **Phase 1.5 迭代章节 IT9-IT11（skill 拔插 + 评测回测）** + 待确认章节 + 缺陷修复章节 + 版本 0.1.0/0.2.0）

  - `README.md` / `README_cn.md`（增补 Phase 1.5）

- **Phase 1.5 能力演进机制已确认并固化**：

  - 引擎 skill 拔插：教学引擎与画像/自适应引擎支持增加/调整多 skill。

  - 评测回测门禁：自建轻量 + 统一评测接口（可切换 promptfoo/agentbench/deepeval）；rubric 打分 + A/B 胜率 + 快照基线；每周抽样、每月全量；人工拦截后应用。

- 已把 `project-creator` skill 复制到账号全局 skills 目录（`C:\Users\Windows11\.trae-cn\builtin\global\skills\project-creator`），新会话可通过 Skill 工具调用。

- **IT13 0.3.0 收尾 + 真实闭环验证（2026-09-09）**：版本统一 0.3.0（package.json / lock 两处 / 启动打印 / README 中英 / development-plan）；git init + `.gitignore`（`.env`、`data/`、`node_modules/`、`dist/` 不入库）；配置真实 qwen key 后全链路真实验证：对话信号判定/文案、每周反思导出、skillGen 分类+规则提炼、EvalGate 真实裁判打分（judgeDegraded=false）均走真实 LLM；费曼学习法 skill 生成→verdict accepted→经人工拦截应用至 `data/skills/active.json`（引擎装配自动叠加）；OQ-7 阈值经首轮真实数据验证无需调整。

- **IT14 0.4.0 学习计划 + 复盘阶段（2026-09-09）**：新增 `src/engines/plans/` 全模块（StudyPlanEngine / ReviewEngine / scoring / crosscheck / anchor / eval / default+llm 策略 / index barrel）+ SQLite 4 张新表与 md 导出 + config plan 段 + Web 9 条路由 + 前端「计划/复盘」tab + 学习事件记录 + 26 例新测试（总 88 例全过）+ 版本 0.4.0 三处一致。机制完整落地：计划↔复盘交叉确认动态更新画像；连续低分触发锚定反思（LLM/启发式修正 + 审计）；两阶段能力经组合加权评测进化（accepted 才应用）。

- **IT14 真实闭环验证 + BUG-001 修复（2026-09-09）**：真实 qwen 全链路验证计划/复盘/锚定/评测（详见「未完成/候选下一步」第 6 条，verdict accepted 已应用）。验证中发现并修复 **BUG-001**：计划/复盘 id 直接用作 md 文件名，topicId 含 Windows 非法字符（`?` 等）时导出 ENOENT——`buildPlanId`/`buildReviewId` 经 `util.sanitizeId` 过滤非法/控制字符并截断，新增回归测试（总 **89 例全过**）。

## 未完成 / 候选下一步

1. **（待定，2026-09-13 复核仍待解决）评测阈值复核**：OQ-7 阈值经首轮真实数据验证无需调整（candidate 均分 9.1≥6、加权 delta +0.5>0、NDAR 无回退→accepted），但**仅 3 条冻结线程样本**，与设计目标周抽样 20–30 条差距明显。**必须积累真实交互数据后复核**抽样规模与各维均分分布；种子数据（`npm run seed:threads`）为人工样例，**不可**用于阈值校准。
2. **（可配）真实数据回填**：`data/threads/` 现为「内置种子线程（`npm run seed:threads`）+ 录制层自动累积的真实线程」混合。种子数据（人工教学样例）仅用于让评测链路开箱可跑，接入真实使用后请让评测跑在真实对话数据上，并按需删除种子文件。评测快照需随版本演进维护（`data/evals/snapshots/{socratic,profile}.{baseline,candidate}.json`）。
3. **（已具备）** 生成的草案 skill 应用与回滚：`applyGeneratedSkill` / `listAppliedSkills` / `removeAppliedSkill` / `createEngineManagerFromRegistry`（引擎装配已接入，重启自动启用已应用 skill）。已应用示例：`socratic.feynman`（费曼学习法）。
4. **（低）验证其余内置 LLM**：DOUBAO/DEEPSEEK 未配置 key，真实调用未验证（qwen 已全链路验证）；`LLM_EXTRA_MODELS` 追加任意 OpenAI 兼容模型零代码，按需接入。
5. **（低，待真实凭据）配置 ASR/TTS 语音 key（ASR\_APPID/ASR\_ACCESS\_TOKEN/TTS\_APPID/TTS\_ACCESS\_TOKEN）后即可走真实豆包语音**：两个 Provider 均已是真实 HTTP 实现（**非占位 throw**，2026-09-13 订正），未配凭据时 factory 回退 Mock。配置后用 `npm run build && npm run voice:verify` 一键验证 TTS→ASR 闭环。**限制**：无真实凭据无法端到端验证（本机当前为 Mock 模式）。
6. **（✅ 已完成，2026-09-09）计划/复盘真实闭环验证**：起服务（qwen 真实 LLM）→ `POST /api/plan/generate`（微积分，md 落盘 `data/plans/`）→ confirm → 3 次 `/api/chat` 积累学习事件 → `POST /api/review/generate`（加权分 0.90：目标 1.0/信号 1.0/频率 0.5/掌握度 1.0）→ confirm（交叉确认：微积分掌握度 0.95→1.0、兴趣 +1.0；加权 ≥0.5 未触发锚定）→ 连续两期无事件低分周期（量子力学 0.1、线性代数 0.1）→ 第 2 次低分 confirm 触发**锚定反思**（LLM 修正：深度 4→2、难度 0.66→0.4、速度基线 1→0.6、重复偏向 0→2，审计 `data/anchors/` + `GET /api/anchors/latest`）→ `POST /api/strategy/eval`（候选 plans.adaptive+reviews.adaptive，3 条冻结线程，真实 judge 未降级：plan 4.33→5.33、review 8.33→8.00、综合 6.33→6.67 → verdict **accepted**）→ 自动写入 `data/plans/active.json` 并可 `GET /api/strategy/active` 读回；报告 `data/evals/2026-09-09_strategy.json`。验证中修复 **BUG-001**（见 Bug Fix Log）并新增回归测试（总 89 例全过）。
7. **（可配，0.4.0 新）策略进化扩展**：MVP 为手动触发 + 参数变体候选；后续可把「多轮多次确认后加权不理想」的复盘记录回灌给进化评估，或支持 LLM 写候选策略配置（保留 `PlanReviewStrategyConfig` 接口）。
8. **（✅ 已完成，2026-09-09）向量 RAG / 语义检索（0.5.0—IT15）**：sqlite-vec（零新基建，`node:sqlite` 复用）；关键词检索保留为降级后端；embedding 复用 LLM Provider（`EMBEDDING_MODEL` 未配自动降级纯关键词，不阻塞）。已接入 `/api/resource/search` 与 `bookToSkill` 向量刷新。见 development-plan IT15 及 2A 迭代记录。
9. **（✅ 已完成，2026-09-10）多节点 + 流量回放录制（0.6.0—IT16）**：生产录制层把真实对话/学习事件录制为冻结线程（`data/threads/`）与黄金数据集（`GoldenDataset`，增量抽样 + 语义去重，`loadFrozenThreads` 直接读取）；`src/locks/` 分布式锁（single/file/db）包裹反思/评测定时任务防多实例重复执行；录制为可插拔中间件，MVP 不引 Kafka（`learning_events` SQL 聚合 + node-cron）。见 development-plan IT16 迭代记录。
10. **（✅ 已完成，2026-09-10）MCP Server（0.7.0—IT17）**：`src/mcp` 已建立；7 个 Tools（chat_socratic/get_learner_profile/trigger_reflection/confirm_upgrade/summarize_resource/plan_generate/review_generate）经 `POST /mcp` HTTP JSON-RPC 暴露，复用既有 Web 装配；`tools/list` 已按 MCP 规范对齐（`{ tools: [...] }` + `additionalProperties:false` strict schema）。详见 development-plan IT17 迭代记录。**候选扩展**：MCP stdio 传输、更多工具（strategy/eval/anchors/threads）。
11. **（✅ 已完成，2026-09-13）git 首次提交**：`.git` 已初始化、`.gitignore` 已生效（`.env`、`data/`、`node_modules/`、`dist/` 确实未进入 `git status`），此前 `master` 分支 0 个 commit、全部工程文件 untracked → 架构级改动无回滚点。已完成首次提交并建立回滚点。
12. **（✅ 已完成，2026-09-13）仓库根陈旧残留清理**：删除 `server.log`（记录 v0.3.0 + 端口 3456，与实际 5173 不符的陈旧残留）、`server.err.log`（空）、`response.json`（v0.3.0 时代手工探测转储）；`voice-verify.mjs` 移入 `scripts/verify-voice.mjs` 并规范化为命令 `npm run voice:verify`（未配凭据时明确提示 Mock 模式且退出码 0，配凭据但失败退出码 1）。根目录现仅保留真实工程文件。
13. **（✅ 已完成，2026-09-13）MCP 协议对齐（Streamable HTTP 生命周期）**：详见下节。经官方 MCP SDK v1.29.0 实测握手与调用通过，已可被 DSH `dsh-mcp-client` 以 `transport: streamable-http` 接入。
14. **（✅ 已完成，2026-09-13）BUG-004 修复：`history` 恒为空导致连续信号逻辑是死代码**：`src/web/index.ts`、`src/mcp/tools.ts` 三处硬编码 `history: []`，导致 `latestConsecutive` 与 `consecutiveHit`（「连续 2 次 confused → hint」）**在真实服务里永不触发**。修复：SQLite 新增 `conversations`/`conversation_turns` 两表 + 共享编排 `src/engines/conversation.ts`（`recordTurn`，**先读历史再落库本轮**）收敛三处重复实现；`CONVERSATION_MAX_HISTORY`（默认 20）给历史长度设界。顺带修掉 MCP 侧 `updateFromSignal` 漏 `await`。验收：`test/conversation.test.ts` 7 例（含 `app.inject()` HTTP 端到端）+ `npm run verify:bug004` 8 项全过。详见 development-plan §2C。

## MCP 协议对齐（2026-09-13）

**背景**：此前 `/mcp` 仅实现 `tools/list` 与 `tools/call`，**缺 MCP 生命周期**——实测 `initialize` 返回 `-32601 未支持的方法`。任何标准 MCP 客户端（含 DSH 用的官方 SDK）首个请求都是 `initialize`，故该端点**实际无法被任何客户端接入**。

**实现**（`src/mcp/index.ts`、`src/mcp/types.ts`）：

- **initialize 握手**：返回 `protocolVersion` / `capabilities` / `serverInfo` / `instructions`；`capabilities` 只声明 `tools.listChanged:false`（不提供 prompts/resources/logging，工具集运行期不变）。
- **版本协商**：支持 `2025-06-18`（最新）/ `2025-03-26` / `2024-11-05`；客户端请求受支持版本则原样回显，否则回落最新支持版本。
- **`notifications/initialized`**：按规范返回 **HTTP 202 且无响应体**；`handleJsonRpc` 返回类型改为 `JsonRpcResponse | null`（`null` = 通知）。
- **会话管理**：`initialize` 响应头下发 `Mcp-Session-Id`（UUID，可见 ASCII）；后续请求必须携带，缺失→400、未知/已终止→404；支持 `DELETE /mcp` 显式终止会话（204）。
- **`MCP-Protocol-Version` 头**：缺失时按规范回落假定 `2025-03-26`；取值不受支持→400。
- **`ping`** 支持；**`GET /mcp` → 405**（本服务不提供 server→client 的独立 SSE 流，规范允许）。
- **Origin 校验**（规范 MUST，防 DNS rebinding）：仅放行 `127.0.0.1`/`localhost`/`::1` 与无 Origin 的非浏览器客户端，其余 403。
- **`tools/call` 结果改为规范结构**：`{ content: [{type:'text',text}], structuredContent }`（原实现把裸业务对象直接塞进 `result`，不符合规范）。
- **未知工具错误码修正**：`MethodNotFound(-32601)` → `InvalidParams(-32602)`（对齐规范 §Tools/Error Handling 示例）。

**验证**：
- `npm test` **136 例全过**（新增 4 例：initialize 协商、ping/GET/DELETE/会话校验、Origin 安全；AC4 改为断言未握手 400）。
- **官方 MCP SDK v1.29.0 `StreamableHTTPClientTransport` 真实客户端实测通过**：`connect`（initialize 握手）成功 → `serverVersion: socratic-tutor 0.7.0`、`capabilities: {tools:{listChanged:false}}` → `listTools` 返回 7 个工具 → `callTool(get_learner_profile)` 返回规范 `content[0].type=text` 且含 `structuredContent` → 未知工具正确报 `MCP error -32602`。

**技术要点**：MCP 业务状态与 HTTP 状态码分离（通知=202、会话缺失=400、会话失效=404）；`initialize` 是唯一免除会话头的请求；会话为进程内内存态，DSH 重启后客户端需重新 initialize。

## 产品化加固（2026-09-13）

- **语音链路（ASR/TTS）**：
  - **认知订正**：`DoubaoASRProvider`（`api/v3/auc/bigmodel/recognize/flash`）与 `DoubaoTTSProvider`（`api/v1/tts`）**均为真实 HTTP 实现、并非占位 throw**；仅未配置凭据时 factory 回退 Mock。"提供器逻辑当前为占位 throw"的旧描述不准确。
  - **修复 ASR 解析健壮性**：真实大模型版文本在 `result.utterances[]`（逐句）而非仅 `result.text`，原实现只读 `result.text`，会把真实响应误判为「无识别结果」。现改为 **utterances 逐句优先、回退整段 text**；补 `audio.format`（默认 wav，可配）；**静音 `20000003` 返回空文本而非抛错**（交上层降级）。
  - **降级可见性**（此前 Mock 静默生效、易被误认为真实识别）：新增 `providers.isVoiceDegraded()`；启动打印 ASR/TTS provider 并在 Mock 模式输出醒目告警；`/api/voice/chat` 响应新增 `voiceDegraded` / `asrProvider` / `ttsProvider`。
  - 新增 `test/asr.test.ts` **7 例**（utterances 优先、text 回退、format/资源头透传、静音、业务错误码、空结果、未配置不发请求）。
- **评测数据冷启动**：
  - 新增 `src/tracing/seed.ts`（`SEED_THREADS` 4 条多主题多轮种子 + `seedThreads` 幂等落盘 + `toFrozenThread`）与 `npm run seed:threads`。此前 `data/threads/` 仅有 1 个**非标准**手工样例（`sample.json`），真实使用前评测实际跑在空集或桩样本上。现落盘 4 条标准 FrozenThread（4 主题、含 mistake/confused 失败信号，满足分层与失败优先抽样）。删除 `sample.json`。
  - **修复 BUG-003**：黄金数据集默认写 `data/threads/golden.json`，而 `loadFrozenThreads` 扫描该目录全部 `*.json` → **同一条线程被计入两次**（实测 4 → 8、id 全部重复），会虚增样本量并污染评测报告。现 `loadFrozenThreads(dir, skipFiles)` 默认跳过 `golden.json`，两处调用点传 `path.basename(config.tracing.goldenFile)` 兼容自定义路径。新增回归测试。
  - 新增 `test/seed.test.ts` **5 例**（标准格式可加载、幂等、失败信号可被失败优先抽样、toFrozenThread、BUG-003 回归）。
- **验证**：`npm test` **133 例全过**（121 → 133）；`npm run build` 通过；实测 `/api/voice/chat` 返回 `voiceDegraded=true`；启动日志正确输出 Mock 告警；`npm run seed:threads` 幂等（第二次写入 0）。

- **仍未解决（诚实登记，不可由种子数据替代）**：**OQ-7 阈值校准样本量不足**——阈值当年仅经 **3 条**冻结线程样本验证，而设计目标周抽样为 **20–30 条**。种子数据是人工样例，**不能**用于重新校准阈值；必须积累真实交互数据后复核。当前 `data/threads/` 为种子与录制线程混合（如 `t-local-user-___-20260913.json` 系语音接口实测自动录制；非 ASCII 主题名被 `safeToken` 归一为 `_`，属既知行为）。

## 已知问题 / 坑

- 本机 Python 环境未确认；实时语音/本地模型未来可能需 Python sidecar（已预留边界，勿在 Node 内硬接未成熟 SDK）。

- 豆包默认模型名需按豆包实际接口确认后再定 `LLM_MODEL`。

- key 泄漏风险：`.env` 不入库（`.gitignore` 已建立生效，IT13 落地；2026-09-13 首次提交后已真正入库保护，**提交前须再次确认 `.env` 未被 `git add`**）。

- 评测阈值（OQ-7）经首轮真实周报校准，无需调整（IT13）；待真实数据量积累后复核抽样规模。

- **版本 0.7.0**：package.json / package-lock.json（两处）/ src/index.ts 启动打印 / README（中英）/ development-plan 已全部统一至 0.7.0（IT17 完成）。

## 迭代扩展（0.2.x）

- **IT12 LLM Provider 切换 + 独立评测 judge + 配置化自动注册（完成，2026-09-03）**：单一 OpenAI 兼容注册清单 `config.llm.models`（`LLMModel` 接口 + `parseExtraModels`）；内置 doubao/deepseek/qwen + `LLM_EXTRA_MODELS` JSON 追加，**追加任何 OpenAI 兼容模型零代码**。统一由 `src/providers/llm/openai-compat.ts`（OpenAICompatProvider：chat/streamChat/structuredCall）承载，删除语义重复的 `doubao.ts`/`deepseek.ts`。`LLMRegistry` 遍历 models 注册（懒加载）+ `getJudge()`（judge.model 显式→覆盖 model 重建缓存，否则跟随主）。`config.llm.judge`（JUDGE_PROVIDER/JUDGE_MODEL）；`index.ts` EvalScheduler 改传 judge，启动打印 judge 配置。`.env.example` 补 QWEN/LLM_EXTRA_MODELS/JUDGE。`npm test` 59 例全过（新增 providers 7 例）。
- **IT10c when-to-use 使用场景 + 组合编排（完成，2026-09-03，0.3.0）**：确认 book-to-skill 产物带场景感知。`src/engines/skills/when.ts`（新增 matchWhen/evaluateWhen/canHandleFor 共享判定）+ `types.ts` `SkillWhen`（concepts/signals/consecutive/profileMasteryLt/exclusiveGroup/priority）+ `manager.ts` `run` when 门控 + 互斥组 canHandle 竞合。补全生成链路三处断链：`generateFromKnowledge` 构造 rules 补 `when`、`createSkillFromRules` 挂 `when/canHandle/exclusiveGroup`、`buildSkillCode` 生成码注入 when（import `../when.js` + `...gate`）；说明文档增"使用场景（when-to-use）"段。修复 when.ts 类型位置 `!` 致 build 失败。`npm test` 62 例全过。
- **IT13 0.3.0 收尾 + 真实闭环验证（完成，2026-09-09，0.3.0）**：版本统一 0.3.0（三处代码 + README 中英 + development-plan）；git init + `.gitignore`；配置真实 qwen key（`LLM_PROVIDER=qwen` / `QWEN_MODEL=qwen3.7-flash`）验证真实闭环：chat 信号/文案、反思导出、skillGen 提炼、EvalGate 真实裁判（`data/evals/2026-09-09_socratic_weekly.json`，verdict accepted、各维 +0.5、A/B 3:0、judgeDegraded=false）；费曼学习法 skill 经人工拦截 `applyGeneratedSkill` 应用（`data/skills/active.json`，引擎装配 `["socratic.core","socratic.feynman"]`）；OQ-7 阈值经首轮真实数据验证无需调整。`npm test` 62 例全过、`npm run build` 通过。

## 迭代扩展（0.4.0）

- **IT14 学习计划阶段 + 复盘阶段（完成，2026-09-09，0.4.0）**：新增 `src/engines/plans/`（types/util/scoring/crosscheck/anchor/study-plan/review/eval/default-strategy/llm-strategy/index 共 11 文件）。`StudyPlanEngine`：按主题生成学习计划 md（幂等、draft→confirmed、LLM 失败降级默认启发式）；`ReviewEngine`：周期末四维加权评分（目标完成率 0.4/信号正确率 0.2/频率达成率 0.2/掌握度变化 0.2，`PLAN_W_*` 可配且归一化）生成复盘 md，confirm 后依次执行**交叉确认**（`runCrossCheck`：达标主题经 `applyProfileDelta` 抬升掌握度 +0.05 与兴趣，未达标记 improvement）与**锚定反思**（`adjustAnchors`：连续 `PLAN_ANCHOR_STREAK` 次加权分 < `PLAN_ANCHOR_THRESHOLD` → LLM structuredCall 修正锚点，失败/无 LLM 启发式降级，审计 SQLite + `data/anchors/<reviewId>.md`）；`eval.ts`：`runStrategyEval`（baseline/candidate 两套 plan+review 策略经冻结线程生成文档 → 两维 LLM-as-Judge（planQuality/reviewQuality）→ `combined=0.5*plan+0.5*review` → accepted/rejected/needs_review，judge 缺失一律 needs_review）→ accepted 经 `applyStrategy` 写 `data/plans/active.json`，`createStrategyManagerFromRegistry` 装配叠加默认。SQLite 新增 study_plans/reviews/anchor_adjustments/learning_events 四表 + export md 三件套；config plan 段（anchorStreak/anchorThreshold/reviewWeights/strategyEval）；Web 新增 9 条路由 + 对话/语音自动记录学习事件；前端新增「计划/复盘」tab（生成/确认/评分进度条/锚点审计摘要/手动策略评测）。设计文档 `.trae/documents/0.4.0-study-plan-review-stages.md`。`npm test` 88 例全过（新增 26 例：study-plan 8 / review 7 / anchor 5 / plan-eval 6）、`npm run build` 通过、版本统一 0.4.0。

## 迭代扩展（0.5.0）

- **IT15 向量 RAG / 语义检索（完成，2026-09-09，0.5.0）**：见「当前进度」IT15 条目——sqlite-vec + `node:sqlite` 向量语义检索（`RAG_BACKEND=hybrid` 向量优先 + 关键词兜底），embedding 复用主 LLM（`EMBEDDING_MODEL` 未配自动降级），接入 `/api/resource/search`；`test/vec.test.ts` 6 例；`npm test` 95 例全过、版本统一 0.5.0。

## 迭代扩展（0.6.0）

- **IT16 多节点 + 流量回放录制（完成，2026-09-10，0.6.0）**：新增 `src/tracing/replay.ts`（`ReplayRecorder` 录制中间件 + `buildThreadId` 幂等安全字符）、`src/tracing/sample.ts`（`sampleThreads` 分层抽样：按 topic 分层 + 失败优先预算 + 语义去重，缺 embedding 退化为 id 去重）、`src/tracing/golden.ts`（`GoldenDataset` 黄金数据集：增量抽样 audit + 幂等 add，输出 FrozenThread[] 数组可被 `loadFrozenThreads` 直接读取）、`src/locks/`（`createDistributedLock` single/file/db 三后端 + `withLock`）。`scheduler/index.ts`/`eval-cron.ts` 定时任务（反思/评测）经分布式锁防多实例重复执行；`web/index.ts` `/api/chat` 与 `/api/voice/chat` 完成一轮后自动录制（默认开、失败静默）。config/.env.example 新增 `tracing.*` 与 `deploy.*`（mode/lockBackend/lockDir/lockTtlMs）。新增 `test/{replay,sample,lock}.test.ts` 10 例（AC1 录制幂等、AC2 失败优先+分层+去重、AC3 分布式锁 file/db 并发互斥）。file/db 锁并发抢占用 `Promise.all` 模拟多实例，锁 TTL 为崩溃恢复兜底；MVP 不引 Kafka。`npm test` 105 例全过、`npm run build` 通过、版本统一 0.6.0。

## 迭代扩展（0.7.0）

- **IT17 MCP Server（完成，2026-09-10，0.7.0）**：新增 `src/mcp/context.ts`（`McpContext` 共享上下文：cfg/providers/store/learnerId/parser/profile/socratic/reflection/resource/planEngine/reviewEngine/remind/strategies）、`src/mcp/types.ts`（JSON-RPC 2.0 请求/响应/错误结构 + `JsonRpcError` + 错误码 ParseError/InvalidRequest/MethodNotFound/InvalidParams/InternalError/ServerError + 入参辅助 requiredString/asObject）、`src/mcp/tools.ts`（7 工具注册表 `MCP_TOOLS`：chat_socratic/get_learner_profile/trigger_reflection/confirm_upgrade/summarize_resource/plan_generate/review_generate + `listTools`/`hasTool`/`callTool`）、`src/mcp/index.ts`（`handleJsonRpc` 分发 + `registerMcpServer` 挂载 `POST /mcp`）。`web/index.ts` 装配 `mcpCtx` 并调用 `registerMcpServer`；config/.env.example 新增 `mcp.{enabled,transport}` 与 `MCP_ENABLED`/`MCP_TRANSPORT`（默认开，`MCP_ENABLED=false` 不注册 `/mcp`）。新增 `test/mcp.test.ts` 15 例（AC1 tools/list 7 项；AC2 各工具与 Web API 语义一致且复用存储、记录学习事件、导出 md；AC3 错误码 MethodNotFound/InvalidParams/InvalidRequest；AC4 开关不注册/注册 `/mcp`）。MCP 为对外封装，通过共享 `McpContext` 复用 Web 同批引擎，不重复实现业务逻辑。`npm test` 120 例全过、`npm run build` 通过、版本统一 0.7.0。增强（2026-09-10）：`tools/list` 按 MCP 规范对齐——结果包裹 `{ tools: [...] }`、`inputSchema` 补 `additionalProperties:false` strict schema、`McpToolSchema`→`McpToolSpec`/`schema`→`spec` 更名，测试断言结构合规。

