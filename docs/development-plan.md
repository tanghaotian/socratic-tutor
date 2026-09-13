# 开发计划文档：Socratic Tutor

- 版本：v1.1.0（与设计文档 v1.1.0 对齐）

- 目标版本：0.4.0（已发布；下一目标按 §1 预留阶段）

- 日期：2026-09-09

- 阶段：代码开发（Project Creator 阶段 3）

- 技术栈：Node.js/TypeScript + Fastify + SQLite（node:sqlite）+ Provider 抽象（LLM 默认豆包，qwen/deepseek/EXTRA 可切）

***

## 1. 版本与迭代映射

- 0.1.0：Phase 1 完成（文本对话 + 画像/自适应 + 反思闭环 + Web 界面 + 非实时语音 + 资料引擎/基础 RAG）。

- 0.2.0：Phase 1.5 完成（引擎 skill 拔插 + 自建评测回测门禁，统一评测接口）。

- 0.3.0：when-to-use 使用场景 + 组合编排 + 真实 LLM/评测闭环验证（版本对齐 + git 基建）。

- 0.4.0：学习计划阶段 + 复盘阶段（计划/复盘 md + 交叉确认 + 加权锚定反思 + 组合加权进化评估）。

- 0.5.0（已完成）：向量 RAG / 语义检索（sqlite-vec，零新基建）——见 IT15。对应设计 `socratic-tutor_detail-design.md` §10「向量 RAG」。

- 0.6.0（已完成）：多节点 + 流量回放录制（Web 无状态横扩 + SQLite 主/副本 + 分布式锁 + 生产流量录制层）——见 IT16。对应设计 §10「多节点」。

- 0.7.0（已完成）：MCP Server（`src/mcp`，7 个 Tools，进程外/HTTP JSON-RPC，挂载于 /mcp）——见 IT17。对应设计 §11。

***

## 2. 任务拆解（自包含）

### IT1 工程初始化与 Provider 抽象

- **What**：搭建 TS 项目骨架、配置、统一 LLM/ASR/TTS/Reminder/Search Provider 接口与注册表，默认豆包。目标版本 0.1.0。

- **Constraints**：用 Node v24 + TS；Provider 一律 interface + 工厂注册表；禁止在引擎层直接依赖某 SDK。

- **Files**：`package.json`、`tsconfig.json`、`src/providers/llm/{index,doubao,deepseek}.ts`、`src/providers/asr|tts|reminder|search/*`、`.env.example`

- **Expected Outcome**：`getProvider('llm').structuredCall(...)` 可调用豆包并返回结构化结果；切换 provider 仅改配置。

- **Acceptance Criteria**：`npm run build` 通过；一个最小 LLM 调用返回非空结果（配置 DOUBAO\_API\_KEY）。

- **状态**：✅ build 通过；Provider 抽象（LLM 注册表 + doubao/deepseek 适配器 + web reminder）已落地；ASR/TTS/Search 由 IT6/IT7 完成；真实 LLM 最小调用已由 IT13 真实闭环验证（qwen）。

### IT2 教学引擎（Socratic + Signal） ✅ 已完成

- **What**：苏格拉底提问策略序列引擎与回答信号解析。目标 0.1.0。

- **Constraints**：严格遵循 socratic-tutor_detail-design.md 5.1/5.2 伪代码；不依赖具体前端。

- **Files**：`src/engines/socratic.ts`、`src/engines/signal.ts`

- **Expected Outcome**：输入回答 → 输出四类信号 + 教学动作（ask/hint/evaluate/explain/recommend/assess\_self）。

- **Acceptance Criteria**：单元测试覆盖 4 类信号分支；"confused 高频时给 hint" 行为成立。

- **实现备注**：`SignalParser.parse` 走 `LLMProvider.structuredCall` 判定四类信号，失败降级为规则兜底；`SocraticEngine.generateAction` 采用「确定性题型路由 + LLM 生成文案」——题型由规则决定（confused 连续 2 次→hint、correct 连续 2 次→self\_eval、mistake→evaluate、divergent→open、其余→conflict/focus），便于单测；画像以最小 `AdaptiveProfile` 契约注入（IT3 前用默认画像，不阻塞）。新增 `test/socratic.test.ts`（7 例全过）与 `npm test`（tsx --test）。

### IT3 学习画像与自适应 ✅ 已完成

- **What**：画像数据结构 + 持久化(SQLite) + 自适应参数。目标 0.1.0。

- **Constraints**：画像字段遵循 socratic-tutor_detail-design.md 1.1；存储走 `storage` 层，禁止散落写文件。

- **Files**：`src/engines/profile.ts`、`src/storage/sqlite.ts`

- **Expected Outcome**：每次回答后画像可读写；weeklyAvg/mastery 更新；返回 adaptiveParams。

- **Acceptance Criteria**：冒烟测试：模拟多次对话后画像持久化并可读回。

- **实现备注**：`SqliteStorage`（`node:sqlite`，Node 24 内置，零额外原生依赖）以 learnerId 一行 JSON 持久化画像；`ProfileEngine` 依信号更新掌握度（correct↑/mistake·confused↓，发散不升降）/频率（totalSessions、近 7 天 lastStudyDates 去重计 weeklyAvg、上限 30 条）/兴趣加权；`adaptiveParams` 由掌握度映射 `targetDepth`、累计失败次数映射 `repetition`；`toAdaptiveView` 适配 IT2 的 `AdaptiveProfile` 契约。新增 `test/profile.test.ts`（5 例，含持久化回读冒烟），`npm test` 共 12 例全过。

### IT4 反思闭环 ✅ 已完成

- **What**：定时调度(周五19:00) + 生成升级需求文档 + Web 提醒 + 确认机制。目标 0.1.0。

- **Constraints**：升级文档未确认不进入设计与开发；cron 用 node-cron；提醒走 ReminderProvider(web)。

- **Files**：`src/engines/reflection.ts`、`src/scheduler/index.ts`、`src/providers/reminder/web.ts`

- **Expected Outcome**：手动触发 `POST /api/reflect` 生成 draft 文档，Web 提醒，confirm 后状态 confirmed。

- **Acceptance Criteria**：触发后生成 `data/reflections/<date>.md`(draft)；未 confirm 不改状态。

- **实现备注**：`ReflectionEngine.run(trigger, opts, remind)` 按日期幂等生成 draft → SQLite `reflections` 表持久化 → `exportReflectionMarkdown` 落盘 `data/reflections/<date>-<trigger>.md` → `ReminderProvider.notify` Web 提醒；`confirm(id)` 仅 draft→confirmed；LLM 结构化失败降级为空 draft 不中断。`Scheduler`（node-cron）承载定时与手动触发。依赖新增 `node-cron`。新增 `test/reflection.test.ts`（4 例），`npm test` 共 16 例全过。

### IT5 Web 服务与界面 ✅ 已完成

- **What**：Fastify REST + WS、Vue 聊天界面、画像页、反思/升级页。目标 0.1.0。

- **Constraints**：路由遵循 socratic-tutor_detail-design.md API 契约；前端用 **Vue**；语音用非实时上传。

- **Files**：`src/web/*`、`public/*`

- **Expected Outcome**：浏览器可完成文本对话、查看画像、查看并确认升级文档。

- **Acceptance Criteria**：`npm run dev` 启动，浏览器 `POST /api/chat` 返回动作，画像页可看；反射确认按钮生效。

- **实现备注**：新增 `src/web/index.ts`（Fastify，fastify\@4 默认导出；静态托管 `public/` + REST：`POST /api/chat`→信号+画像+动作、`GET /api/profile`、`POST /api/learn/topic`、`POST /api/reflect`、`GET /api/reflection/latest`、`POST /api/reflect/:id/confirm`）；`src/index.ts` 改为装配存储+调度器+Web 服务启动。前端 `public/index.html`（Vue3 CDN）实现对话页/画像页/反思升级页（含确认按钮）。依赖新增 `fastify`、`@fastify/static`。本地验证：`POST /api/reflect` 生成 draft+md、`confirm`→confirmed、`POST /api/chat` 在无 key 时降级 fallback 正常。注：fastify 需 `Content-Type: application/json`（Fastify 默认 415 拦截非 JSON POST）。

### IT6 非实时语音 ✅ 已完成

- **What**：整段录音 → ASR → 文本 → 对话 → TTS → 播报。目标 0.1.0。

- **Constraints**：Phase1 非实时；音频处理用 fluent-ffmpeg；ASR/TTS 走 Provider。

- **Files**：`src/providers/asr/*`、`src/providers/tts/*`、语音上传接口、前端录制/播放控件。

- **Expected Outcome**：上传录音返回文本对话结果并可播报语音回复。

- **Acceptance Criteria**：浏览器录制→上传→收到文本与音频 URL→播放 全链路可跑通。

- **实现备注**：新增 ASR/TTS Provider 抽象实现——`DoubaoASRProvider`/`DoubaoTTSProvider`（火山接口，未配置 key 时抛错）、`MockASRProvider`/`MockTTSProvider`（本地占位：MockTTS 生成 0.5s 静音 WAV，保证无 key 也能联调全链路）。`ProviderContainer.getASR()/getTTS()` 按配置（ASR\_APPID/ASR\_ACCESS\_TOKEN/TTS\_APPID/TTS\_ACCESS\_TOKEN）优先豆包、否则 Mock。`src/engines/voice.ts` 提供 `runVoiceTurn`（录音→ASR→文本处理→TTS→音频URL，任一步失败降级不中断）；`src/storage/audio.ts` `AudioStore` 统一落盘 data/audio。Web 新增 `POST /api/voice/chat`（multipart：file+topicId）+ `/audio/*` 静态提供；前端录音/停止/播放控件。依赖新增 `@fastify/multipart`。本地验证：curl 上传 wav → 返回转写文本+回复文本+`/audio/*.wav` URL（200/size/audio-wav）。新增 `test/voice.test.ts`（2 例：全链路+ASR 失败降级），`npm test` 共 18 例全过。

### IT7 资料引擎（基础版 + book-to-skill） ✅ 已完成

- **What**：联网检索、书籍/论文/视频结构化总结、book-to-skill 生成本地 md、轻量入库检索。目标 0.1.0。

- **Constraints**：产物写入 `knowledge/skills/`；**RAG 采用轻量 md 全文/关键词检索 + LLM 筛选**（不引入向量库）。

- **Files**：`src/engines/resource.ts`、`src/providers/search/*`、`src/storage/rag.ts`

- **Expected Outcome**：提交资料可产出结构化总结并生成 skill md；检索可命中。

- **Acceptance Criteria**：样例资料生成 `knowledge/skills/<slug>.md`；`POST /api/resource/search` 返回结果。

- **实现备注**：`ResourceEngine` 提供 `summarize`（LLM 结构化：key\_points/teaching\_implications/followups，失败降级原文截断标记）、`bookToSkill`（生成 `knowledge/skills/<slug>.md` 并刷新 RAG）、`searchWeb`（SearchProvider，默认 Mock 占位）、`queryRag`（`RAGStore` 关键词检索）。`RAGStore`（src/storage/rag.ts）轻量实现：加载 `knowledge/skills/*.md` → 中文逐字/英文按词分词 → 分块打分 → 标题加权 → Top-K（不引入向量库，符合 Phase1 约束）。`MockSearchProvider`（src/providers/search/mock.ts）联网检索占位。Web 新增 `POST /api/resource/summarize`、`POST /api/resource/search`（联网+本地双路）。新增 `test/resource.test.ts`（4 例：bookToSkill 生成 md、RAG 命中、searchWeb、无命中返回空），`npm test` 共 22 例全过。

### IT8 README + scripts + HANDOFF + 版本（项目管理产物） ✅ 已完成

- **What**：README.md/README\_cn.md、scripts dev/build、HANDOFF.md、版本号三处一致。目标 0.1.0。

- **Constraints**：双语内容一致；scripts 薄封装 package.json；版本在 package.json/README/开发计划一致。

- **Files**：`README.md`、`README_cn.md`、`scripts/{dev,build}.{ps1,sh}`、`HANDOFF.md`

- **Acceptance Criteria**：`scripts/dev.ps1`/`scripts/build.ps1` 能运行到 npm run dev/build；版本号一致。

- **实现备注**：README（中英）进度同步至 IT7、版本号去掉"规划中"改 0.1.0；scripts `{dev,build}.{ps1,sh}` 为薄封装（缺失 node\_modules 时先 install），验证 `build.ps1` EXIT=0、`dev.ps1` 可启动至 `npm run dev`（无 DOUBAO\_API\_KEY 属已知项，脚本本身正常）；HANDOFF 更新至 IT8、Phase 1 收尾；版本 package.json/README/开发计划三处一致 0.1.0。**Phase 1（0.1.0）全部落地**。

### IT9 引擎 skill 拔插（迭代版本 0.2.0，Phase 1.5） ✅ 已完成

- **What**：为教学引擎与画像/自适应引擎引入能力策略接口（CapabilitySkill，**纯 TS**）+ 策略管理器（StrategyManager），支持 skill 增加/替换/叠加/启停/快照。含「知识产物 → 能力策略 skill」可选增强链路的生成接口（见 socratic-tutor_detail-design.md §8.2.1，输入教学/教育方法论类知识 md，输出 CapabilitySkill 草案，经 IT10 门禁 + 人工拦截后注册）。

- **Constraints**：严格遵循 socratic-tutor_detail-design.md §8 接口设计；skill 不侵入引擎核心，引擎只经 `StrategyManager.run` 消费；LLM 走 Provider；能力策略目录用 `src/engines/skills/`，与 `knowledge/skills/`（RAG 资料库）分离。

- **Files**：`src/engines/skills/types.ts`、`src/engines/skills/manager.ts`、`src/engines/skills/socratic/*.ts`、`src/engines/skills/profile/*.ts`、改造 `socratic.ts`/`profile.ts`

- **Expected Outcome**：同一引擎可在启用不同 skill 组合下运行；配置可快照导出。

- **Acceptance Criteria**：单元测试验证 register/enable/disable/list/run/叠加；旧接口（未加 skill）可运行不回归。

- **版本**：0.2.0。

- **实现备注**：新增 `src/engines/skills/`——`types.ts`（CapabilitySkill/SkillContext/SkillResult/SkillMeta/ActiveSkill/ProfileDelta，遵循 §8.1）、`manager.ts`（StrategyManager：register 新增/替换、enable/disable、list/listAll、snapshot 导出激活配置、run 按注册顺序叠加执行并注入 prevAction 供后 skill 改写）、`socratic/core.ts`（承接 IT2 全部确定性路由+LLM 文案逻辑为 `socratic.core`，默认激活保证回归）、`socratic/interest.ts`（`socratic.interest` 叠加示例：在 core 动作内容前追加激励引导，默认不激活）、`profile/core.ts`（承接 IT3 画像增量推导为 `profile.core`，产出 ProfileDelta）、`index.ts`（`createSocraticManager(llm)`/`createProfileManager()` 默认组合 + 导出）。改造 `socratic.ts`/`profile.ts` 只经 `manager.run` 消费（`updateFromSignal` 改 async 以便 await run；`SocraticEngine`/`ProfileEngine` 均暴露 `skills` getter 供注册/启停/快照），`web/index.ts` 两处调用补 await。新增 `test/skills.test.ts` 10 例（register 替换、enable/disable/list、snapshot、core 回归、core+interest 叠加改写、禁用 core 无产出、profile core 回归、profile 多 skill delta 合并、引擎注入自定义 manager 后 disable 报错）。`npm test` 共 31 例全过，`npm run build` 通过。知识产物→能力 skill 生成接口（§8.2.1 可选链路）待 IT10 门禁落地后接反思流程。

### IT10 评测回测模块（自建 + 统一接口，迭代版本 0.2.0） ✅ 已完成

- **What**：自建轻量评测：快照基线 + rubric 打分（LLM-as-Judge）+ A/B 胜率 + 每周抽样/每月全量重放 + 本地报告 + 统一评测接口（EvalManager，支持切换 self-built/promptfoo/agentbench/deepeval）。

- **Constraints**：遵循 socratic-tutor_detail-design.md §9；裁判模型可独立配置；评测产物写 `data/evals/`；判定逻辑（rubric delta、winRateDelta、采纳/否决）按已确认阈值落地（rubric 严格 ≥6/10 且 NDAR 不可回退、A/B 人工裁定、每周抽样 20–30 条）。

- **Files**：`src/engines/eval/{types,manager,backends/selfbuilt,backends/adapters,index}.ts`、`src/engines/eval/reflection-gate.ts`、`src/scheduler/eval-cron.ts`、`src/config.ts`（eval 配置）、`src/index.ts`（挂载调度）

- **Expected Outcome**：反思生成新 skill 后触发门禁，输出周报/月报（含 rubric/ab/verdict），由用户确认后应用。

- **Acceptance Criteria**：样例旧/新 skill 跑通产生 `data/evals/<date>_<engine>_weekly.json` 且 verdict 合理；切换评测后端配置生效。

- **实现备注**：新增 `src/engines/eval/`——`types.ts`（EvalEngine/EngineSnapshot/FrozenThread/Rubric/EvalRequest/EvalReport/verdict，遵循 §9）、`manager.ts`（EvalManager：register/setActive/run，统一接口解耦后端）、`backends/selfbuilt.ts`（自建后端：逐线程 baseline/candidate 快照重放 + LLM-as-Judge rubric 打分 + A/B 裁定，judge 失败降级启发式打分并标记 `judgeDegraded`；判定：核心维（engagement/nondirect）任一回退→`rejected`，candidate 均分≥6 且加权 delta>0→`accepted`，达标但无提升或未达标→`needs_review`）、`backends/adapters.ts`（promptfoo/agentbench/deepeval 外部框架占位后端，返回 needs\_review+backendNote，后续替换真实调用）、`reflection-gate.ts`（`runEvalGate`：SKILL\_FACTORIES 按快照 id 重建 skill（registerSkillFactory 供未来生成 skill 接入）、buildSocraticRunner/buildProfileRunner 快照重放器、装配 EvalManager、落盘 `data/evals/<date>_<engine>_<kind>.json`）。`src/scheduler/eval-cron.ts` `EvalScheduler`：每周（`0 20 * * 5`）/每月（`0 9 1 * *`）从 `data/evals/snapshots/` 读 baseline/candidate 快照、从 `data/threads/` 读冻结线程，跑 EvalGate 出周报/月报（无快照/线程时跳过）；`runOnce` 供手动触发。`config.ts` 新增 `eval`（backend/cron/threadsDir/outputDir/weeklySample）；`index.ts` bootstrap 挂载调度。新增 `test/eval.test.ts` 8 例（EvalManager 注册切换/list/未设置报错、self-built accepted/rejected/降级/无 runner 报错、EvalGate 端到端落盘周报、切换外部占位后端）。`npm test` 共 39 例全过，`npm run build` 通过。知识产物→能力 skill 生成（§8.2.1 可选链路）可由反思流程调 `registerSkillFactory` + `runEvalGate` 接入。

### IT11 README/记忆/版本同步（Phase 1.5 发布） ✅ 已完成

- **What**：README/README\_cn 增补 skill 拔插与评测回测说明；HANDOFF 更新；版本号 0.2.0 三处一致；同步项目记忆。

- **Acceptance Criteria**：文档与实现一致；版本三处一致。

- **实现备注**：版本号统一 0.2.0——`package.json`、`package-lock.json`（顶部 + packages 根节点）、`src/index.ts` 启动打印 v0.2.0；README/README\_cn/development-plan 已在前述迭代标 0.2.0；HANDOFF 版本说明更新。`npm test` 52 例仍全过（版本不涉逻辑）。

### IT12 LLM Provider 切换与独立评测 judge（0.2.x 迭代） ✅ 已完成

- **What**：接线阿里云百炼 qwen（OpenAI 兼容）；支持 LLM Provider 运行时切换；评测 judge 可独立于主模型指定更强模型。

- **Acceptance Criteria**：`LLM_PROVIDER=qwen` 即可用百炼 `qwen3.7-flash` 作主模型；`JUDGE_PROVIDER`/`JUDGE_MODEL` 可让周报/月报评测用更强的 judge；不联网场景仍有单测覆盖注册与 judge 选择逻辑。

- **实现备注**：新增 `src/providers/llm/openai-compat.ts`——通用 OpenAI `/v1/chat/completions` 兼容 Provider（`chat`/`streamChat`/`structuredCall`），构造校验缺 key/model 抛错。**配置化自动注册（单一事实来源** **`config.llm.models`）**：config 取消 doubao/deepseek/qwen 具名块，改为 `models` 数组（内置三项走独立 env；可经 `LLM_EXTRA_MODELS` JSON 追加任意 OpenAI 兼容模型，**零代码接入**）；新增导出 `LLMModel` 接口与 `parseExtraModels` 解析函数；删除语义重复的 `doubao.ts`/`deepseek.ts` 类（与 OpenAICompatProvider 同构），`providers/index.ts` 改导出 `OpenAICompatProvider` 与 `LLMRegistry`/`LLMProviderId`。`LLMRegistry` 遍历 `cfg.models` 统一以 OpenAICompatProvider 注册（懒加载），`getJudge()` 从 `models` 按 id 查（judge.model 显式则以覆盖 model 重建并缓存 `<jid>:judge`，否则跟随主）。`config.llm.judge`（`JUDGE_PROVIDER`/`JUDGE_MODEL`，默认空=跟随主模型）。`ProviderContainer.getJudge()` 代理；`index.ts` 的 `EvalScheduler` 改传 `providers.getJudge()`，启动打印 judge 配置。`.env.example` 补 QWEN/LLM\_EXTRA\_MODELS/JUDGE 说明。新增 `test/providers.test.ts` 7 例（清单自动注册、额外模型零代码注册、缺 key 懒加载访问才抛、judge 显式 model 落主并缓存、judge 独立 provider=deepseek、judge.model 空跟随主、构造校验）。`npm test` 共 59 例全过，`npm run build` 通过。

### IT10c when-to-use 使用场景 + 组合编排（迭代版本 0.3.0） ✅ 已完成

- **What**：为 skill 提供明确的"何时/何种场景引用"（when-to-use）门控，并支持组合引用多个 skill 时的竞合收敛。此前 when 判定/组合机制已在运行时（`StrategyManager.run`）成形，但 book-to-skill 生成产物未接入 `when`——提炼出的使用场景在进入最终 skill 时被丢弃。本迭代补全三处断链，使生成产物带场景感知。

- **Files**：`src/engines/skills/types.ts`（`SkillWhen` 接口 + `CapabilitySkill.when/canHandle/exclusiveGroup`）、`src/engines/skills/when.ts`（新增共享判定 `matchWhen/evaluateWhen/canHandleFor`）、`src/engines/skills/manager.ts`（`run` 增加 when 门控 + 互斥组 canHandle 竞合）、`src/engines/skillgen/index.ts`（`extractRules` 提炼 when、`createSkillFromRules` 挂 when/canHandle/exclusiveGroup、`buildSkillCode` 生成码注入 when、`generateFromKnowledge` 构造 rules 补 when、说明文档增"使用场景（when-to-use）"段）

- **实现备注**：when 判定为 AND——声明维度全命中才适用，命中维度数与 `priority` 作为 `canHandle` 组合权重；`exclusiveGroup` 同组多 skill 命中时仅 `canHandle` 最高者执行（组合引用竞合收敛）；未声明 when = 始终适用（兼容旧叠加）。共享判定逻辑抽到 `when.ts`，运行时（`createSkillFromRules`）与生成码（`buildSkillCode` 内联等价文本 + import `../when.js`）行为一致。修复 `when.ts` 两根非法 TS 类型语法（类型位置 `!`）导致 build 失败。新增 `test/skillgen.test.ts` 4 例（extractRules 提炼 when、buildSkillCode 注入 when/canHandle/exclusiveGroup、createSkillFromRules+StrategyManager when 门控只激活命中场景、互斥组内仅 canHandle 最优者执行）。`npm test` 共 62 例全过，`npm run build` 通过。

### IT10b 能力 skill 生成链路（§8.2.1，迭代版本 0.2.0） ✅ 已完成

- **What**：知识产物（book-to-skill 知识 md）→ 能力策略 skill 的全链路：判定教学/教育方法论类 → LLM 提炼规则（含降级）→ 生成纯 TS CapabilitySkill 草案 + 说明文档 → 注册评测门禁工厂 → 跑 runEvalGate 回测 → 人工拦截。反思流程可经 `skillGen` 选项触发扫描，把草案元信息并入反思报告。

- **Constraints**：遵循 socratic-tutor_detail-design.md §8.2.1 可选链路；产物仍是纯 TS CapabilitySkill（§8.1 形态一致）；生成 skill 的 apply 为确定性规则实现（不依赖 LLM，可离线测试）；知识 md 与引擎 skill 目录分离（`knowledge/skills/` vs `src/engines/skills/generated/`）。

- **Files**：`src/engines/skillgen/index.ts`、`src/engines/reflection.ts`（ReflectionReport.skillDrafts + options.skillGen）、`src/storage/sqlite.ts`（导出 md 增补草案段落）

- **Expected Outcome**：反思把方法论类知识一键产出能力 skill 草案，经门禁 verdict 供人工拦截后 enable。

- **Acceptance Criteria**：方法论类 md 生成 `<id>.ts`（合法 TS）+ `docs/skills/<id>.md`；`runSkillGenPipeline` 跑通出 verdict；非方法论不生成；反思报告记录草案。

- **实现备注**：新增 `src/engines/skillgen/index.ts`——`classifyMethodology`（LLM structuredCall 判定，失败降级关键字启发式并标记 llmJudged）、`extractRules`（LLM 提炼 purpose/strategy/triggers/phrase/interestBoost，失败降级通用默认）、`buildSkillCode`（生成纯 TS：内联 RULES 常量 + 确定性 apply；socratic=叠加改写、profile=兴趣增量，工厂函数名 PascalCase）、`createSkillFromRules`（运行时等价实现）、`generateFromKnowledge`（判定→提炼→生成→写盘+说明文档）、`registerGeneratedSkill`（调 registerSkillFactory 使 runEvalGate 可重建）、`runSkillGenPipeline`（全链路：判定→生成→注册工厂→baseline vs baseline+新skill 跑 runEvalGate 出 verdict，供人工拦截）、`scanKnowledgeDirForSkills`/`idFromFilename`。**应用步骤**：`applyGeneratedSkill`（持久化到 `data/skills/active.json` 已应用注册表 + 注册工厂，幂等同 id 覆盖）、`listAppliedSkills`/`removeAppliedSkill`、`createEngineManagerFromRegistry`（装配引擎 manager = 默认 core 组合 + 已应用 skill 叠加；`web/index.ts` 已把 socratic/profile 引擎改为经它装配，应用后重启即启用）。接反思：`ReflectionReport` 增 `skillDrafts?: SkillDraftMeta[]`、`ReflectionEngineOptions` 增 `skillGen`（knowledgeDir/engine/llm/write），run 中可选扫描并记录（不写盘不改引擎仅记录，默认 write=false）；`sqlite.exportReflectionMarkdown` 增"能力 skill 草案（§8.2.1）"段落。新增 `test/skillgen.test.ts` 13 例（classify LLM/启发式、extractRules 提炼/降级、buildSkillCode+createSkillFromRules 叠加、profile 兴趣增量、generateFromKnowledge 写盘+id 派生、runSkillGenPipeline 方法论出 verdict/非方法论不生成、scan 仅方法论产出、ReflectionEngine 接入记录草案、应用步骤写表/幂等覆盖/回滚/按引擎装配叠加与过滤）。`npm test` 共 52 例全过，`npm run build` 通过。全链路闭环：知识 md → 评判定级 → 提炼 → 生成草案 → 评测 verdict → 人工拦截 → `applyGeneratedSkill` 应用 → 引擎装配自动启用。

### IT13 0.3.0 收尾 + 真实闭环验证（迭代版本 0.3.0） ✅ 已完成（2026-09-09）

- **完成情况（2026-09-09）**：三件事全部落地——1) 版本统一 0.3.0（package.json / package-lock.json 两处 / src/index.ts / README 中英，`npm run build` 通过、`npm test` 62 例全过）；2) git init + `.gitignore`（`.env`、`data/`、`node_modules/`、`dist/` 均确认不入库，消除 key 泄漏风险）；3) 配置真实 qwen key（`LLM_PROVIDER=qwen` + `QWEN_MODEL=qwen3.7-flash`）后跑通真实闭环，逐项验证结果：

  | 验证项 | 结果 |
  | --- | --- |
  | DashScope key 直接调用 | HTTP 200，模型正常应答 |
  | `POST /api/chat` 真实信号判定+文案 | confused→focus 追问，文案为真实 LLM 生成 |
  | `POST /api/reflect` 反思导出 | 真实 observations/improvements/新需求，落盘 `data/reflections/2026-09-09-manual.md` |
  | skillGen 真实提炼 | `knowledge/skills/feynman-technique.md` → classify=true（LLM）、extractRules 提炼 purpose/strategy/triggers/when，生成合法 TS（`src/engines/skills/generated/socratic.feynman.ts`）+ `docs/skills/socratic.feynman.md`，经 `npm run build` 编译通过 |
  | 评测真实裁判 | `runSkillGenPipeline` 内置 EvalGate：`judgeDegraded=false`，rubric 各维 +0.5（candidate 均分 9.1），A/B 3:0，verdict **accepted**，周报落盘 `data/evals/2026-09-09_socratic_weekly.json` |
  | 应用步骤 | 人工拦截确认后 `applyGeneratedSkill` 写入 `data/skills/active.json`；`createEngineManagerFromRegistry('socratic')` 装配 = `["socratic.core","socratic.feynman"]`（profile 不受影响） |

- **阈值校准结论（OQ-7）**：首轮真实数据验证既有阈值合理，**无需调整**——candidate 均分 9.1≥6、加权 delta +0.5>0、核心维（engagement/nondirect）无回退 → accepted，判定分支与设计一致。注意：本次验证仅 3 条冻结线程样本（目标周抽样 20–30 条），待真实对话数据量积累后再复核抽样规模与各维均分分布。

- **What**：三件事——1) 版本对齐 0.3.0（IT10c 文档已标 0.3.0，代码仍 0.2.0）；2) git 初始化 + `.gitignore`（消除 HANDOFF 已知的 key 泄漏风险）；3) 配置真实 key 后验证**真实 LLM/评测闭环**并据首轮周报校准 OQ-7 阈值。补齐当前"能力全就位但从未真实跑过"的缺口：对话信号判定、反思导出、skillGen 提炼、EvalGate rubric 打分、快照/线程样本、周报落盘、阈值校准。

- **Constraints**：`.env` 不入库（git init 后立即建 `.gitignore`）；真实 key 由用户提供；未配置 key 时全链路仍走降级且显式标注（不阻塞工具链验证）；不改动既有任务条目。

- **Files**：`package.json`、`package-lock.json`（顶部 + 根节点两处）、`src/index.ts`（启动打印）、`.gitignore`（新增）、`README.md` / `README_cn.md`、`docs/development-plan.md`、`HANDOFF.md`、`.env`（用户填）、`data/evals/snapshots/{socratic,profile}.{baseline,candidate}.json`、`data/threads/*.json`

- **Expected Outcome**：
  - 版本三处一致 **0.3.0**；`npm test` 62 例仍全过，`npm run build` 通过。
  - 配置真实 key 后：`POST /api/chat` 信号判定与文案走真实 LLM（无降级标记）；反思 `run` 导出 md 含真实内容；`skillGen` 的 `classifyMethodology`/`extractRules` 为真实 LLM 提炼；`runEvalGate` 周报 rubric 为真实 LLM-as-Judge 打分（无 `judgeDegraded`）。
  - 首轮周报落盘 `data/evals/<date>_<engine>_weekly.json`，据此校准 OQ-7 阈值并回写本计划。

- **Acceptance Criteria**：
  - 版本号三处一致 0.3.0。
  - git 仓库可提交，且 `git status` 确认 `.env`、`data/`、`node_modules/`、`dist/` 均不入库。
  - 有 key：chat 返回真实结构化信号；反思 md 真实；EvalGate 报告 rubric 无降级标记；周报 verdict 合理。
  - 无 key：全链路可用且报告显式标注降级。
  - OQ-7 阈值校准结论回写本迭代章节。

- **实现备注**：
  - 版本统一手法同 IT11（package.json + lock 两处 + index.ts 打印 + README 中英 + HANDOFF）。
  - git：`git init` → 建 `.gitignore`（`node_modules/`、`dist/`、`.env`、`data/`、`*.db`）→ 首次提交不含敏感文件。
  - 真实闭环验证清单：1) `POST /api/chat` 冒烟；2) `POST /api/reflect`（带 `skillGen` 选项）→ 检查导出 md；3) 放 `knowledge/skills/<methodology>.md` → `runSkillGenPipeline` 出草案与 verdict；4) 造 baseline/candidate 快照 + 冻结线程 → `EvalScheduler.runOnce` 触发周报 → 人工检查 rubric 均分/winRateDelta/verdict。
  - 阈值校准：以首轮周报各维均分与加权 delta 为据，回写 OQ-7（rubric 严格 ≥6/10、NDAR 不可回退、周抽样 20–30 条）；如实际偏差过大，调整 `backends/selfbuilt.ts` 判定参数。
  - **阻塞项**：真实 LLM 与评测打分需用户提供 `DOUBAO_API_KEY` / `DOUBAO_MODEL`（或改 `LLM_PROVIDER=qwen|deepseek`），judge 可选 `JUDGE_PROVIDER` / `JUDGE_MODEL`。

### IT14 学习计划阶段 + 复盘阶段（迭代版本 0.4.0） ✅ 已完成（2026-09-09）

- **完成情况（2026-09-09）**：两个阶段全部落地——`src/engines/plans/` 新增 10 文件（types/util/scoring/crosscheck/anchor/study-plan/review/eval/default-strategy/llm-strategy + index barrel），SQLite 新增 4 张表（study_plans/reviews/anchor_adjustments/learning_events）+ export md 三件套；Web 新增 `/api/plan/*`、`/api/review/*`、`/api/strategy/*` 共 9 条路由；前端新增「计划/复盘」tab；对话/语音自动记录学习事件。`npm test` **88 例全过**（新增 26 例）、`npm run build` 通过、版本统一 0.4.0。

- **What**：新增两个阶段化跟踪环节——1) **学习计划阶段**：`StudyPlanEngine` 按主题生成学习计划 md（目标掌握度/深度/会话数，锚点快照），draft→confirmed，幂等；2) **复盘阶段**：`ReviewEngine` 在计划周期末按**四维加权评分**（目标完成率 0.4 / 信号正确率 0.2 / 频率达成率 0.2 / 掌握度变化 0.2，权重可配且归一化）生成复盘 md，confirm 后触发两条自我更新机制——**交叉确认**（计划目标 ↔ 复盘结果，达标主题经 `applyProfileDelta` 抬升画像掌握度+兴趣）与**锚定反思**（连续 `PLAN_ANCHOR_STREAK` 次加权分 < 阈值 → 判断"学员学习情况锚定假设"是否有误，LLM 修正优先 + 启发式降级，审计落 SQLite + `data/anchors/<reviewId>.md`）；3) **进化评估**：`eval.ts` 对 plan/review 两阶段生成能力做**组合加权评测**（两维 LLM-as-Judge 打分 × plan/review 各 0.5 权重合成，A/B 对比 baseline/candidate），verdict=accepted 才写 `data/plans/active.json` 注册表，`createStrategyManagerFromRegistry` 装配时叠加默认策略。

- **Constraints**：画像字段不加新字段（锚点 = 最近一次 AnchorAdjustment 的 `after`，无则画像现算默认锚点）；评分公式纯确定性可复现，LLM 只产出定性内容；进化评估 MVP 仅手动触发 + 少量冻结线程，judge 缺失一律 needs_review 不自动应用；不改动既有任务条目。

- **Files**：`src/engines/plans/{types,util,scoring,crosscheck,anchor,study-plan,review,eval,default-strategy,llm-strategy,index}.ts`（新增）、`src/storage/sqlite.ts`（4 表 + get/save/list + export md 三件套）、`src/engines/profile.ts`（仅 export `applyProfileDelta`，行为不变）、`src/config.ts`（plan 段）、`src/index.ts`（装配 + 版本 0.4.0 打印）、`src/web/index.ts`（9 条路由 + 学习事件记录）、`public/index.html`（计划/复盘 tab）、`package.json` / `package-lock.json`（版本 0.4.0）、`.env.example`（plan 配置）、`test/{study-plan,review,anchor,plan-eval}.test.ts`（新增 26 例）、`README.md` / `README_cn.md`、`docs/development-plan.md`、`HANDOFF.md`

- **Expected Outcome**：
  - 学习计划/复盘均可生成 md、draft→confirmed、幂等；复盘确认触发交叉确认画像增量。
  - 连续低分自动触发锚定反思并落审计；组合加权评测出 A/B verdict，accepted 才应用。
  - 版本三处一致 0.4.0；`npm test` 88 例全过，`npm run build` 通过。

- **Acceptance Criteria**：
  - `StudyPlanEngine.run/confirm/latest` 与 `ReviewEngine.run/confirm/latest` 全链路可用（含 LLM 失败降级启发式）。
  - `computeReviewScore` 加权分 ∈ [0,1] 且权重归一化；交叉确认对达标主题画像 +0.05 掌握度与兴趣。
  - 连续 2 次加权分 < 阈值自动 `adjustAnchors`（llm/heuristic 两路）→ SQLite 审计 + `data/anchors/<reviewId>.md`。
  - `runStrategyEval` verdict 三分支（accepted/rejected/needs_review）+ judge 降级不自动应用；`applyStrategy` 幂等写 active.json 并可重读装配。
  - Web 路由与前端 tab 可用；版本号三处一致 0.4.0。

- **实现备注**：
  - 数据模型与公式详见 `.trae/documents/0.4.0-study-plan-review-stages.md`（本迭代设计文档）。
  - 学习事件：`/api/chat` 与 `/api/voice/chat` 在信号解析后 `appendLearningEvent`，作为复盘评分的输入源。
  - 复盘 `confirm` 顺序：先置 confirmed → 交叉确认落库 → 锚定反思（返回 `anchorAdjustment` 或 null）。
  - 前端「手动策略评测」按钮内置一组候选参数变体（plans.adaptive + reviews.adaptive），judge 真实打分后由用户判断是否应用。
  - 进化评估 MVP 限定参数变体候选，不做 LLM 写 TS 源码（省编译风险，留接口后续演进）。

### IT15 向量 RAG / 语义检索（迭代版本 0.5.0） ✅ 已完成

- **What**：在现有轻量关键词检索（`src/storage/rag.ts`，IT7）之上引入**语义向量检索**，解决"关键词不命中但语义相关"的检索缺口。技术选型依据设计 `socratic-tutor_detail-design.md` §10「向量 RAG」：**优先 sqlite-vec（零新基建，复用 Node 24 内置 `node:sqlite`）**，LanceDB/Qdrant 仅作备用。向量 RAG 与前序问题背景（`topics.md` 多节点调研）呼应：仅当出现**语义相似检索/去重**需求时才引入，不提前做向量库。

- **Constraints**：
  - 严格遵循 `socratic-tutor_detail-design.md` §10；关键词检索**保留为降级后端**，二者可切换/可混合（query 命中关键词→关键词分高；语义相关→向量分高）。
  - 嵌入向量来源：优先复用现有 LLM Provider（OpenAI 兼容 embedding），未配 embedding key 时**自动降级为关键词检索**（不阻塞全链路）。
  - RAG 对外接口 `queryRag` 语义不变（返回 `RagHit[]`），向量仅为内部实现替换，避免改动调用方（Resource/Socratic/plan）。

- **Files**：`src/storage/vec.ts`（新增，sqlite-vec 加载 + 向量表 + 检索）、`src/storage/rag.ts`（改造：关键词之外接可选向量后端）、`src/config.ts`（`storage.ragBackend`、`llm.embedding` 段）、`src/providers/llm/embeddings.ts`（新增，embedding 封装）、`.env.example`（`RAG_BACKEND`、`EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`）、`test/vec.test.ts`（新增）、`package.json`（`sqlite-vec` 依赖）

- **Expected Outcome**：语义相近但无共同关键词的查询能命中对应知识片段；关键词检索功能不回归（降级路径可用）；`npm test`/`npm run build` 通过。

- **Acceptance Criteria**：
  1. `sqlite-vec` 在 Node 24 + `node:sqlite` 下正常加载并建向量表（单测验证）；加载失败时无崩溃并打印降级提示。
  2. 有 embedding：`post /api/resource/search` 返回结果中，语义相关（无关键词交集）查询也能返回 top-k（单测用固定向量断言余弦相似度排序）。
  3. 无 embedding key/失败：`queryRag` 走关键词后端，返回结果与改造前一致（IT7 4 例回归全过）。
  4. `toVec/reload` 与 `RAGStore.search` 从同一知识目录（`knowledge/skills/*.md`）构建，新增 skill 后 `reload()` 同步刷新向量。
  5. `npm test` 全过（含新增 vec 用例）、`npm run build` 通过；版本统一 0.5.0（三处一致）。

### IT16 多节点部署 + 流量回放录制（迭代版本 0.6.0） ✅ 已完成

- **What**：两步——1) **生产流量录制层**：把真实对话/学习事件录制为冻结线程与黄金数据集，供评测回放（EvalGate/strategy-eval）与自我更新采样（呼应 `topics.md` 多节点调研结论：不引 Kafka，SQL 直查 `learning_events` + 定时任务即可）；2) **多节点部署准备**：Web 无状态横扩 + SQLite 主/副本或按 learnerId 分片 + 定时任务分布式锁，避免重复执行。对应设计 `socratic-tutor_detail-design.md` §10「多节点」。

- **Constraints**：
  - 遵循设计 §10：Web 层无状态可横扩；SQLite 单写主 + Litestream 只读副本（或按 learnerId 分片）二选一落地；定时任务（反思/评测/复盘）必须经**分布式锁**防重复执行。
  - **MVP 不引入 Kafka**：录制与统计直接走 `learning_events` 表 SQL 聚合 + `node-cron`（延续 IT14 现状），Kafka 仅在流量规模质变后再评估。
  - 录制层作为可插拔中间件（默认开），不侵入既有对话/复盘业务逻辑。

- **Files**：`src/tracing/replay.ts`（新增，录制中间件：对话→FrozenThread）、`src/tracing/sample.ts`（新增，分层抽样 + 失败优先 + 语义去重抽典型问题）、`src/tracing/golden.ts`（新增，黄金数据集维护）、`src/locks/`（新增，分布式锁：进程内+可选 DB/文件锁后端）、`src/scheduler/index.ts` 与 `eval-cron.ts`（改造：任务包分布式锁）、`src/web/index.ts`（挂载录制中间件）、`src/config.ts`（`tracing`、`deploy` 段）、`test/{replay,sample,lock}.test.ts`（新增）

- **Expected Outcome**：线上对话被自动录制为冻结线程并可按策略抽取典型问题维护黄金数据集；同一任务多实例并发时仅一个实例执行；`npm test`/`npm run build` 通过。

- **Acceptance Criteria**：
  1. 录制层：`/api/chat` 与 `/api/voice/chat` 完成一轮后，自动把结构化对话（含 signal）按 **FrozenThread 格式**写入 `data/threads/`（单测验证字段齐备、幂等去重）。
  2. 分层抽样：`sampler.sample(threads, {strategy:'layered', failureFirst:true, dedup:true})` 返回的样本中，**失败优先**（mistake/confused 信号）命中率高于随机基线；语义去重用 embedding 相似度去重（未配 embedding 退化为 id 去重）。
  3. 黄金数据集：`golden` 可增量追加/审计选中线程，输出文件可被 `loadFrozenThreads`（`scheduler/eval-cron.ts`）直接读取用于评测。
  4. 分布式锁：同一任务（反思/评测/复盘 cron）在模拟多实例（同锁实现高并发调用）下**仅一个实例执行**（单测）。
  5. `npm test` 全过、`npm run build` 通过；版本统一 0.6.0（三处一致）。

### IT17 MCP Server（迭代版本 0.7.0） ✅ 已完成

- **What**：落地设计 `socratic-tutor_detail-design.md` §11「IDE 集成（MCP，预留）」——暴露 7 个 Tools：`chat_socratic`、`get_learner_profile`、`trigger_reflection`、`confirm_upgrade`、`summarize_resource`、`plan_generate`、`review_generate`。实现为**进程外/HTTP JSON-RPC**，Node 侧统一封装，供 IDE（TRAE 等）/系统边界图 `IDE --> MCP`（overall-design §3）接入。已建成 `src/mcp` 并挂载于既有 Web 的 `/mcp`。

- **Constraints**：
  - 严格遵循 `socratic-tutor_detail-design.md` §11 的 7 个 Tools 清单与命名；MCP Server 是**对外封装**，本质复用既有 Web 装配与引擎，不重复实现业务逻辑。
  - 进程外 JSON-RPC：用现有 Fastify 加一个 `/mcp` 挂载点（HTTP transport），或独立端口；Node 侧统一封装工具调用，屏蔽内部 engine 细节。
  - 鉴权：复用 `.env` 现有 LLM/存储配置；Tools 仅暴露已设计的能力，不新增业务能力。

- **Files**：`src/mcp/index.ts`（新增，MCP Server 装配/启动 + 传输）、`src/mcp/tools.ts`（新增，7 个 tool 的 JSON-RPC 映射到既有引擎/路由逻辑）、`src/mcp/types.ts`（新增，JSON-RPC 请求/响应/错误结构）、`src/web/index.ts`（改造：挂载 `/mcp` 或暴露复用入口）、`src/config.ts`（`mcp` 段：enabled/port/transport）、`.env.example`（`MCP_ENABLED`、`MCP_PORT`、`MCP_TRANSPORT`）、`test/mcp.test.ts`（新增）、`README.md`/`README_cn.md`（MCP 用法）、`HANDOFF.md`

- **Expected Outcome**：TRAE/IDE 本地或远端可经 MCP 调用 Socratic 对话、查画像、触发/确认反思、资料总结、生成计划与复盘；与 Web 页面能力一致且可独立于 UI 访问。

- **Acceptance Criteria**：
  1. 7 个 tool 全部在 MCP Server 注册并能被 JSON-RPC 调用（`tools/list` 返回 7 项）。
  2. `chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate` 各自的请求/响应与 Web 既有 API 语义一致，且复用同一存储与配置（`STORAGE_DIR`）。
  3. JSON-RPC 错误处理：非法 method→`MethodNotFound`；缺参→`InvalidParams`；Provider/存储异常→`InternalError`（单测覆盖）。
  4. 未启用（`MCP_ENABLED=false`）时不启动 MCP 监听，不影响既有 Web 服务；启用时 `/mcp` 可访问。
  5. `npm test` 全过（含新增 mcp 用例）、`npm run build` 通过；版本统一 0.7.0（三处一致）。

---

## 2A. 迭代版本记录

> 规则：每次迭代/增强完成后在此新增一节，记录新增需求/功能、改动文件与验收，不直接改动既有任务条目。缺陷修复沿用 Bug Fix Log。

### v0.5.0（IT15 向量 RAG / 语义检索，已落地）

- **需求/功能**：在关键词 RAG 之上引入语义向量检索（sqlite-vec，零新基建，Node 24 `node:sqlite`），关键词保留为降级后端；检索接口 `queryRag` 语义不变，新增 `queryRagHybrid`。
- **改动文件**：
  - `src/providers/llm/embeddings.ts`（新增）：`EmbeddingProvider` 接口 + `OpenAICompatEmbedding`（OpenAI /v1/embeddings）+ `HashEmbeddingProvider`（确定性本地嵌入，测试/离线用）。
  - `src/storage/vec.ts`（新增）：`VectorStore`（sqlite-vec 加载 / 建表 / upsert / KNN / clear）。
  - `src/storage/rag.ts`：构造支持 `{ embedding?, backend }`；`reload()` 异步重建向量索引；新增 `ensureVectors()` / `searchHybrid()`（向量优先 + 关键词兜底）。
  - `src/engines/resource.ts`：构造支持 `{ embedding?, ragBackend?, rag? }`；`bookToSkill` 同步刷新向量；新增 `queryRagHybrid()`。
  - `src/providers/factory.ts`：`getEmbedding()`（按 `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` 构建，未配置返回 null）。
  - `src/config.ts` / `.env.example`：新增 `storage.ragBackend`、`embedding.{provider,model,dim}`、`RAG_BACKEND`/`EMBEDDING_*`。
  - `src/web/index.ts`：`/api/resource/search` 走 `queryRagHybrid` 并返回 `backend` 字段。
  - `test/vec.test.ts`（新增，6 例）：AC-1~AC-4。
  - `package.json` / `package-lock.json`：依赖新增 `sqlite-vec@^0.1.9`；版本 0.4.0→0.5.0。
- **验收**：AC-1 sqlite-vec 加载建表 KNN ✅；AC-2 语义相关（无关键词交集）命中 ✅；AC-3 无 embedding/keyword 后端回归纯关键词 ✅；AC-4 reload 后向量索引同步 ✅；`npm test` 95 例全过 ✅；`npm run build` 通过 ✅；版本三处一致 0.5.0 ✅。
- **技术要点**：`node:sqlite` 需 `allowExtension:true` 才能加载扩展；`vec0` 表 rowid 必须为整数自增，插入时省略 rowid；模型维度需与 `EMBEDDING_DIM` 一致（默认 1536）。

### v0.6.0（IT16 多节点 + 流量回放录制，已落地）

- **需求/功能**：新增生产流量录制层（真实对话→冻结线程→黄金数据集）与多节点部署准备（分布式锁防定时任务重复执行、Web 无状态），遵循设计 §10「多节点」。MVP 不引 Kafka，录制/统计直接走 `learning_events` SQL + node-cron。
- **改动文件**：
  - `src/tracing/replay.ts`（新增）：`ReplayRecorder` 录制中间件（对话→FrozenThread，幂等去重）+ `buildThreadId`（learner+topic+当日收敛一致、sanitizeId 安全字符）。
  - `src/tracing/sample.ts`（新增）：`sampleThreads` 分层抽样（按 topic）+ 失败优先（mistake/confused 预算加权）+ 语义去重（embedding 相似度，缺省退化为 id 去重）。
  - `src/tracing/golden.ts`（新增）：`GoldenDataset` 黄金数据集维护（增量抽样 audit + 幂等 add），输出 FrozenThread[] 数组，`loadFrozenThreads` 可直接读取。
  - `src/tracing/index.ts`（新增）：统一导出。
  - `src/locks/`（新增）：`createDistributedLock`（single 进程内 / file / db 三后端）+ `withLock`。
  - `src/scheduler/index.ts` / `eval-cron.ts`：定时任务（反思/评测）经分布式锁防重复执行。
  - `src/web/index.ts`：`/api/chat` 与 `/api/voice/chat` 完成一轮后挂载录制（`cfg.tracing.enabled` 默认开，失败静默）；初始化 recorder。
  - `src/config.ts` / `.env.example`：新增 `tracing.{enabled,threadsDir,goldenFile}` 与 `deploy.{mode,lockBackend,lockDir,lockTtlMs}`。
  - `test/{replay,sample,lock}.test.ts`（新增，10 例）。
  - `package.json` / `package-lock.json`：版本 0.5.0→0.6.0。
- **验收**：AC1 录制层 `/api/chat` 与 `/api/voice/chat` 均自动录制 FrozenThread 且幂等 ✅；AC2 分层抽样失败优先高于随机基线 + 语义去重（缺 embedding 退化为 id 去重）✅；AC3 黄金数据集增量/幂等，输出可被 `loadFrozenThreads` 读取 ✅；AC4 分布式锁（single/file/db）同任务多实例并发仅一个执行 ✅；`npm test` 105 例全过 ✅；`npm run build` 通过 ✅；版本三处一致 0.6.0 ✅。
- **技术要点**：file/db 锁并发抢占用 `Promise.all` 模拟多实例（顺序调用无法触发互斥）；锁 TTL 过期为崩溃恢复兜底；录制为可插拔中间件（默认开），不侵入既有对话/复盘逻辑。

### v0.7.0（IT17 MCP Server，已落地）

- **需求/功能**：落地 design §11「IDE 集成（MCP）」——在既有 Fastify Web 上挂载 `POST /mcp`，实现 MCP JSON-RPC 2.0 的 `tools/list`/`tools/call`，暴露 7 个 Tools：`chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate`。MCP 为**对外封装**，通过共享上下文复用 Web 同一批引擎/存储/provider，不重复实现业务逻辑。
- **改动文件**：
  - `src/mcp/context.ts`（新增）：`McpContext` 共享上下文接口（cfg/providers/store/learnerId/parser/profile/socratic/reflection/resource/planEngine/reviewEngine/remind/strategies）。
  - `src/mcp/types.ts`（新增）：JSON-RPC 2.0 请求/响应/错误结构 + `JsonRpcError` + 错误码（ParseError/InvalidRequest/MethodNotFound/InvalidParams/InternalError/ServerError）+ 入参辅助（requiredString/asObject）。
  - `src/mcp/tools.ts`（新增）：`MCP_TOOLS` 7 工具注册表 + `listTools()`/`hasTool()`/`callTool()`；每个 tool 复用既有路由侧引擎调用（chat 解析信号/更新画像/记录学习事件/生成动作，plan/review 同 `/api` 语义，reflection/summarize 同引擎）。
  - `src/mcp/index.ts`（新增）：`handleJsonRpc()` 分发 + `registerMcpServer()` 在 Fastify 挂载 `/mcp`（`MCP_ENABLED=false` 时不注册）。
  - `src/web/index.ts`：装配共享 `mcpCtx` 并调用 `registerMcpServer`。
  - `src/config.ts` / `.env.example`：新增 `mcp.{enabled,transport}` 段与 `MCP_ENABLED`/`MCP_TRANSPORT`。
  - `test/mcp.test.ts`（新增，15 例）。
  - `package.json` / `package-lock.json`：版本 0.6.0→0.7.0。
- **验收**：AC1 `tools/list` 返回 7 项 ✅；AC2 7 工具请求/响应与 Web 语义一致且复用 `STORAGE_DIR` 同一存储 ✅；AC3 JSON-RPC 错误处理（MethodNotFound/InvalidParams/InvalidRequest/InternalError，单测覆盖）✅；AC4 `MCP_ENABLED=false` 不注册 `/mcp`，启用时 `/mcp` 可访问 ✅；`npm test` 120 例全过 ✅、`npm run build` 通过 ✅、版本三处一致 0.7.0 ✅。
- **技术要点**：MCP 作为对外封装通过共享 `McpContext` 复用既有装配（不重复构建引擎）；`handleJsonRpc` 统一捕获 `JsonRpcError` 与未知异常映射为标准错误码；`tools/call` 才做工具分发，`tools/list` 返回 MCP 规范结构（`{ tools: [...] }`，每个 Tool 的 `inputSchema` 为标准对象 schema 且 `additionalProperties:false` 严格模式，required 字段均声明于 properties）。

> 增强记录（2026-09-10）：按 MCP 规范对齐 `tools/list`——结果包裹为 `{ tools: Tool[] }`，`inputSchema` 补 `additionalProperties:false`（strict schema），`McpToolSchema` 更名 `McpToolSpec`、注册表字段 `schema`→`spec`；测试断言每个 tool 的 schema 结构（type=object / additionalProperties=false / required⊆properties）。改动仅 `src/mcp/tools.ts`、`src/mcp/index.ts`（计数改读 `MCP_TOOLS.length`）、`test/mcp.test.ts`。`npm test` 120 例全过、`npm run build` 通过。

> 修复记录（2026-09-13）：**BUG-002** —— 交付验收复核实测发现 `POST /mcp` 恒返回 `{}`（200），MCP 端点对外不可用。根因：路由 handler 未 `await`/`return` async 的 `handleJsonRpc`，Fastify 序列化未决 Promise 为 `{}`。**暴露测试盲区**：原有用例全部直接调用 `handleJsonRpc()`（函数级正确 ≠ 端点可用），AC4 用 `fakeApp` 桩只断言注册行为，全仓库从未使用 `app.inject()` 走过 HTTP 边界。修复：`src/mcp/index.ts` 改为 `await` + `return`；`test/mcp.test.ts` AC4 两条重写为真实 Fastify 实例 + `app.inject()`（禁用时断言 404），并新增 HTTP 层回归用例（`tools/list` 非 `{}`、`tools/call` 返回真实画像、错误码经 HTTP 正确透出）。`npm test` **121 例全过**、`npm run build` 通过、真实 HTTP 实测通过。**后续纪律**：新增路由能力必须至少有一条经 `app.inject()` 的端点级用例。

> **MCP 协议对齐（2026-09-13，Streamable HTTP 生命周期）**：BUG-002 只修了「响应被吞成 `{}`」，但端点仍**缺 MCP 生命周期** —— 实测 `initialize` 返回 `-32601 未支持的方法`。任何标准 MCP 客户端（含 DSH 使用的官方 SDK）首个请求都是 `initialize`，因此该端点此前**实际无法被任何客户端接入**。本次补齐：
>
> - **改动文件**：`src/mcp/types.ts`（协议版本常量 `MCP_PROTOCOL_VERSIONS`/`negotiateProtocolVersion`/`resolveProtocolVersion`、`MCP_SERVER_INFO`、`isNotification`、`McpCallToolResult`）、`src/mcp/index.ts`（`initialize` 握手、`notifications/initialized`→202、`ping`、会话管理 `Mcp-Session-Id`、`MCP-Protocol-Version` 校验、`DELETE` 终止会话、`GET`→405、Origin 校验防 DNS rebinding、`toCallToolResult` 结果信封、handler 返回类型改 `JsonRpcResponse | null`）、`test/mcp.test.ts`（新增 4 例 + 改写 AC2/AC3/AC4/BUG-002 断言）。
> - **规范要点**：initialize 是唯一免除会话头的请求；客户端请求受支持版本则原样回显，否则回落本服务最新（`2025-06-18`）；通知以 HTTP 202 空响应处理；缺 `MCP-Protocol-Version` 头时按规范回落假定 `2025-03-26`，取值不支持→400；会话缺失→400、会话失效/未知→404。
> - **`tools/call` 结果信封**：原实现把裸业务对象直接放入 `result`（不符合规范），现改为 `{ content: [{type:'text',text}], structuredContent }` —— 文本块供模型阅读，`structuredContent` 供客户端程序化消费（二者并存）。
> - **错误码修正**：未知工具由 `MethodNotFound(-32601)` 改为 `InvalidParams(-32602)`，对齐规范 §Tools/Error Handling 示例。
> - **验收**：`npm test` **136 例全过** ✅；`npm run build` 通过 ✅；**官方 MCP SDK v1.29.0（DSH `dsh-mcp-client` 所用同一 SDK）`StreamableHTTPClientTransport` 真实客户端实测通过** ✅ —— `connect` 握手成功、`serverVersion=socratic-tutor 0.7.0`、`listTools` 返回 7 项、`callTool` 返回规范 content + structuredContent、未知工具报 `-32602`。
> - **遗留（未做，非阻塞）**：stdio 传输；SSE 流式（当前为单次 JSON 响应，规范允许）；`notifications/tools/list_changed`（工具集运行期不变，已声明 `listChanged:false`）；会话为进程内内存态，重启需重新 initialize。

---

## 2B. 产品化加固记录（2026-09-13）

> 规则同 2A：记录新增能力、改动文件与验收，不改动既有任务条目。本次为交付验收复核后的**加固轮**（P2 清理 + 产品化缺口），版本仍为 0.7.0（无对外接口破坏性变更，仅新增响应字段与脚本）。

### 加固项 1：语音链路（ASR/TTS）订正与健壮性

- **认知订正**：`DoubaoASRProvider` / `DoubaoTTSProvider` **均已是真实 HTTP 实现，并非占位 throw**；仅未配置凭据时 `factory.ts` 回退 Mock。此前 HANDOFF「提供器逻辑当前为占位 throw」的描述不准确，已订正。
- **改动文件**：
  - `src/providers/asr/doubao.ts`：结果文本改为 **`result.utterances[]` 逐句优先、回退 `result.text`**（真实大模型版返回形态）；补 `audio.format`（默认 `wav`，可经构造参数覆盖）；**静音 `X-Api-Status-Code=20000003` 返回空文本而非抛错**（交上层降级）；新增 `buildText` 提取辅助。
  - `src/providers/factory.ts`：新增 `isVoiceDegraded()`（ASR/TTS 任一走 Mock 即为真）。
  - `src/index.ts`：启动打印 ASR/TTS provider id；Mock 模式输出醒目告警（避免静默降级被误认为真实识别）。
  - `src/web/index.ts`：`/api/voice/chat` 响应新增 `voiceDegraded` / `asrProvider` / `ttsProvider`。
  - `scripts/verify-voice.mjs`（由仓库根 `voice-verify.mjs` 移入并规范化）：未配凭据时提示 Mock 模式、退出码 0；配凭据但调用失败退出码 1；接入 `npm run voice:verify`。
  - `test/asr.test.ts`（新增，7 例）。
- **验收**：`test/asr.test.ts` 7 例全过（utterances 优先 / text 回退 / format 与资源头透传 / 静音 / 业务错误码 / 空结果 / 未配置不发请求）✅；实测 `/api/voice/chat` 返回 `voiceDegraded=true`、`asrProvider=mock-asr` ✅；启动日志正确输出 Mock 告警 ✅。
- **技术要点**：极速版识别接口**业务状态码在响应头** `X-Api-Status-Code`（非 body），与 HTTP 状态码分离；`20000003` 表示静音属正常业务结果。

### 加固项 2：评测数据冷启动与 BUG-003

- **问题**：`data/threads/` 此前只有 1 个**非标准**手工样例（`sample.json`），真实使用前评测实际跑在空集或桩样本上；且黄金数据集与线程文件同目录会重复加载。
- **改动文件**：
  - `src/tracing/seed.ts`（新增）：`SEED_THREADS`（4 条多主题多轮种子，覆盖 4 主题、含 mistake/confused 失败信号）+ `seedThreads()`（幂等落盘 FrozenThread）+ `toFrozenThread()`；经 `src/tracing/index.ts` 导出。
  - `scripts/seed-threads.mjs`（新增）：`npm run seed:threads`，落盘并回报可加载线程数与主题覆盖。
  - `src/scheduler/eval-cron.ts`：`loadFrozenThreads(dir, skipFiles = ['golden.json'])` **跳过黄金集文件**（BUG-003）；`runCron` 传 `path.basename(config.tracing.goldenFile)`。
  - `src/web/index.ts`：`/api/strategy/eval` 同上传递跳过文件。
  - `data/threads/sample.json`：**删除**（非标准结构，被标准种子取代）。
  - `test/seed.test.ts`（新增，5 例）。
  - `README.md` / `README_cn.md`：新增「辅助命令」段（`seed:threads` / `voice:verify`）与「真实数据回填」说明。
- **验收**：`npm run seed:threads` 落盘 4 条标准 FrozenThread、二次执行写入 0（幂等）✅；`loadFrozenThreads` 读回 4 条且覆盖 4 主题 ✅；BUG-003 回归测试通过（golden.json 存在时线程数仍为 4、无重复 id）✅；`npm test` **133 例全过** ✅；`npm run build` 通过 ✅。
- **技术要点**：种子数据为**人工教学样例**，目的是让评测链路开箱可跑并固定口径基线，**不能**用于 OQ-7 阈值校准。

### 加固项 3：P2 仓库根残留清理

- 删除 `server.log`（陈旧：v0.3.0 + 端口 3456，与实际 5173 不符）、`server.err.log`（空）、`response.json`（v0.3.0 时代手工探测转储）；`voice-verify.mjs` 移入 `scripts/`。根目录仅保留真实工程文件。
- **注意**：`.gitignore` 已含 `*.log`，故这些日志本就不入库；本次为工作区整洁性清理。

### 遗留（不可由本轮替代）

- **OQ-7 阈值校准样本量不足**：阈值仅经 **3 条**冻结线程样本验证，设计目标为周抽样 **20–30 条**。须积累真实交互数据后复核，种子数据不可替代。**已量化为可复跑门禁**（见 2C 节 `npm run assess:sample`）。
- 真实 ASR/TTS 端到端验证需用户提供凭据（当前本机为 Mock 模式）。

---

## 2C. Agent 化前置加固记录（2026-09-13）

> 背景：先完成《Agent 化收益与风险评估》（`docs/design/agentification-assessment.md`）中认定的三项**前置条件**，再讨论任何编排层改造。

### 前置 1：回滚点（git 首次提交）

- **问题**：`.git` 已初始化、`.gitignore` 已生效，但 `master` **0 个 commit**，全部工程文件 untracked —— 架构级改动**无回滚点**。
- **处置**：完成首次提交 **`9abe127`**（114 文件）；作者身份经用户确认 `tanghaotian <545804513@qq.com>`（`git config --local`，仅本仓库，不污染全局）。
- **入库前核实**：`.env`（含真实 qwen key）、`data/`、`dist/`、`node_modules/` 均被 `.gitignore` 正确忽略，并经 `git ls-files` 复核**未入库**；提交后工作区 clean。

### 前置 2：修 BUG-004（history 恒为空）

- **改动文件**：`src/storage/sqlite.ts`（+`conversations`/`conversation_turns` 两表与三个读写方法）、**新增** `src/engines/conversation.ts`（`recordTurn`/`actionText`/`nextEventId` + `ConversationDeps`）、`src/web/index.ts`（两处路由改用共享编排；`extractActionText` 上移）、`src/mcp/tools.ts`（`chat_socratic` 改用共享编排）、`src/config.ts`（`conversation.maxHistory`）、`.env.example`。
- **关键设计**：会话按 `learner + topic` 归并（主题切换即重置连续判定）；**必须先读历史再落库本轮**，否则当前轮被计入自身 history，连续次数多算一次；历史长度受 `CONVERSATION_MAX_HISTORY`（默认 20）约束，避免上下文无限增长。
- **顺带修复**：MCP `chat_socratic` 原 `profile.updateFromSignal(...)` **漏 `await`**（画像更新与动作生成存在竞态），经共享编排统一为 `await`。
- **验收**：`test/conversation.test.ts` 新增 7 例（存储排序/主题隔离/limit、编排注入 history、连续 confused→hint、连续 correct→self_eval、跨主题重置、事件与文本落库、**`app.inject()` HTTP 端到端 2 例**）；另有 `npm run verify:bug004`（8 项断言，对 `dist` 产物进程内验证，供 `node:test` 不可用的环境复跑）。
- **为何需要 `verify:bug004`**：本机沙箱下 `node:test` 运行器必须 spawn 子进程（`spawn EPERM`），`npm test` **结构性不可运行**；该脚本不 spawn 任何进程，直接对编译产物断言，覆盖与单测同一组行为。**它已实际发挥作用**：首次运行即抓出一个错误的期望值（`listRecentSignals` 取最近 N 条后应反转为旧→新）。

### 前置 3：真实评测样本 → 量化为可复跑门禁

- **结论（诚实登记）**：该项**无法在当前环境"完成"**——真实样本只能由真实使用累积，不可人工生成（种子数据不可用于阈值校准）。
- **处置**：新增 `scripts/assess-eval-sample.mjs`（`npm run assess:sample`），把「样本够不够、有没有被种子数据污染」变成可量化、可复跑的检查：
  - 区分**真实线程**与**人工种子线程**（`t-seed-*` 前缀），并按主题数、user 轮次、失败型线程分别统计；
  - 对照周抽样目标（`EVAL_WEEKLY_SAMPLE`，默认 25），输出评定与原因；
  - `--json` 供 CI 消费；**退出码 0/1** 即「可否据当前数据校准阈值」的门禁。
- **实测结论（2026-09-13）**：线程总数 5（**真实 1 / 种子 4**），真实样本仅覆盖 1 个主题、1 个 user 轮次 → **未达标**（exit 1），**不应据当前数据校准 OQ-7 阈值**。
- **附加发现**：真实录制线程均为**单轮**（录制层按「一轮 user+agent」落盘），故冻结线程在评测中**不体现连续信号**；修复 BUG-004 后 `conversation_turns` 已具备生成多轮真实线程的数据基础，建议后续补齐录制（属独立改进项，本轮不改）。

### 遗留（不可由本轮替代）

- **真实样本量**：仍需真实使用积累至周抽样 20–30 条，方可用于阈值校准（现由 `assess:sample` 门禁把守）。
- **多轮真实线程录制**：录制层现为单轮，建议后续基于 `conversation_turns` 产出多轮冻结线程（否则评测无法覆盖连续信号路径）。
- 真实 ASR/TTS 端到端验证需用户提供凭据（当前本机为 Mock 模式）。

---

## 3. 待确认问题与重大决策（Open Questions & Major Decisions）

| #    | 问题                     | 候选                        | 影响      | 建议                                                   | 状态                      |
| ---- | ---------------------- | ------------------------- | ------- | ---------------------------------------------------- | ----------------------- |
| OQ-1 | 后端框架                   | Fastify / Express         | 全路由层    | Fastify（性能+类型友好）                                     | **resolved → Fastify**  |
| OQ-2 | 前端方案                   | 原生 HTML/JS / Vue / React  | IT5、IT6 | Vue（组件化，便于后续实时语音 UI）                                 | **resolved → Vue**      |
| OQ-3 | 豆包默认模型名                | 需按豆包实际接入点确认               | LLM 调用  | 用豆包兼容 openai base\_url；`LLM_MODEL` 运行时按实际接入点配置       | **resolved（运行时按接入点配置）** |
| OQ-4 | RAG 实现                 | 轻量 md 检索 / 向量 RAG / 全量上下文 | IT7     | **轻量 md 全文/关键词检索 + LLM 筛选**，不引入向量库；向量 RAG 延迟 Phase 3 | **resolved → 轻量 md 检索** |
| OQ-5 | ASR/TTS 具体服务           | 豆包语音 / OpenAI 兼容 / 稍后     | IT6     | 默认**豆包语音**（与主模型同生态）                                  | **resolved → 豆包语音**     |
| OQ-6 | 初版本地语音是否上传文件 vs base64 | /                         | IT6     | 上传文件                                                 | resolved                |

> 新增待确认（Phase 1.5，2026-09-02）：
>
> - ~~OQ-7 评测判定阈值~~ **resolved → rubric 严格（各维 ≥6/10，NDAR 不可回退）；A/B 人工裁定（不设硬阈值）；每周抽样约 20–30 条、每月全量**
>
>   - ⚠️ **校准充分性未达标（2026-09-13 复核）**：判定口径已定，但阈值实际仅经 **3 条**冻结线程样本验证，远低于设计要求的周抽样 **20–30 条**。种子数据（人工样例）不可用于校准。**待真实交互数据积累后必须复核**各维均分分布与抽样规模。
>
> - ~~OQ-8 skill 形态~~ **resolved → 能力策略 skill 纯 TS 实现**
>
> - 补充：book-to-skill 知识 md（教学/教育方法论类）可作为**能力策略 skill 的可选生成来源**（详情见 requirements.md §2.1 与 socratic-tutor_detail-design.md §8.2.1）。

> 规则：开发中遇到新的待确认或重大决策，一律记录于此，不得擅自决定；用户中途改需求 → 先更新此处 + 同步 socratic-tutor_detail-design.md + 更新本任务，最后才动代码。

> 新增待确认（预留阶段，0.5.0–0.7.0，2026-09-09；见 IT15–IT17）：
>
> - ~~OQ-9 向量 RAG 实现~~ **resolved → 优先 sqlite-vec（零新基建，Node 24 `node:sqlite`），LanceDB/Qdrant 备用；关键词检索保留为降级后端**（IT15）
>
> - ~~OQ-10 多节点流量录制与中间件~~ **resolved → MVP 不引 Kafka，直接 `learning_events` SQL 聚合 + node-cron；录制层为可插拔中间件（默认开）**（IT16）
>
> - ~~OQ-11 多节点 SQLite 拓扑~~ **resolved → 单写主 + Litestream 只读副本 或 按 learnerId 分片 二选一；定时任务经分布式锁防重复**（IT16）
>
> - ~~OQ-12 MCP Server 传输~~ **resolved → 进程外/HTTP JSON-RPC，Node 侧统一封装，复用既有引擎装配**（IT17）

***

## 4. 缺陷修复（Bug Fix Log）

| #         | 缺陷     | 根因(WHY) | 修复方案   | patch/rewrite | 预估token | 状态     |
| --------- | ------ | ------- | ------ | ------------- | ------- | ------ |
| BUG-001（2026-09-09，真实闭环验证发现） | topicId 含 Windows 非法字符时计划/复盘 md 导出 ENOENT | 计划/复盘 id（`2026-09-09-{learner}-{topic}`）直接用作 `data/plans/<id>.md` 文件名；`? / \ : * " < > \|` 在 Windows 文件名中非法（真实场景：客户端把中文 topic 编码为 `?` 触发）；同时 `/` 与 `?` 也会破坏 `/api/*/:id` 路径参数 | `util.sanitizeId`：id 构造处（`buildPlanId`/`buildReviewId`）过滤非法字符与控制字符、空白归一、截断 120；新增回归测试 `buildPlanId 安全化` | patch | 小 | ✅ 已修复（89 例测试全过） |
| BUG-002（2026-09-13，交付验收复核实测发现） | `POST /mcp` 恒返回 `{}`（200），MCP 端点对外完全不可用，IDE/MCP 客户端无法集成 | `src/mcp/index.ts` 路由 handler 内 `const res = handleJsonRpc(...)` 既未 `await` 也未 `return`；`handleJsonRpc` 是 **async**，Fastify 5 收到的是未决 Promise，被序列化成 `{}`。原单测全部直接调用 `handleJsonRpc()`，AC4 用手写桩 `fakeApp` 仅断言注册字符串，**无任何测试经过 HTTP 边界**（全仓库 `.inject()` 零使用），故 120 例全过仍漏出 | `await handleJsonRpc(...)` + `return reply.code(200).send(res)`；重写 AC4 两条为真实 Fastify 实例 + `app.inject()`（并断言禁用时 404）；新增回归测试「HTTP 层 tools/list 与 tools/call 返回真实 JSON-RPC 结果（非 {}）」 | patch | 小 | ✅ 已修复（121 例测试全过、build 通过、真实 HTTP 实测 7 tools/`get_learner_profile`/错误码 -32601 均正确） |
| BUG-003（2026-09-13，产品化加固实测发现） | 黄金数据集刷新后，同一条冻结线程被计入两次，虚增评测样本量并污染报告（实测 4 → 8、id 全部重复） | 黄金数据集默认落盘 `data/threads/golden.json`，而 `loadFrozenThreads(dir)` 扫描该目录**全部** `*.json`；`golden.json` 是已选样本的汇总副本，被当作独立线程文件再次加载 | `loadFrozenThreads(dir, skipFiles = ['golden.json'])` 跳过黄金集文件；两处调用点（`eval-cron.runCron`、`web /api/strategy/eval`）传 `path.basename(config.tracing.goldenFile)` 以兼容自定义路径；新增回归测试「golden.json 不被当作线程重复加载」 | patch | 小 | ✅ 已修复（133 例测试全过） |
| BUG-004（2026-09-13，agent loop 改造评估发现） | 连续信号判定逻辑是**死代码**：「连续 2 次 confused → hint」在真实服务里永不触发 | 运行时 `history` 恒为硬编码空数组（`src/web/index.ts:133`、`:196`、`src/mcp/tools.ts:64`），而设计文档 §1.4 的 `ConversationMessage` 与会话表**从未实现**（全仓 `ConversationMessage\|conversations\|appendMessage` 零命中）。`socratic/core.ts` 的 `latestConsecutive` 与 `when.ts` 的 `consecutiveHit` 依赖历史轮次，故永不命中 | **已实现**：SQLite 新增 `conversations`/`conversation_turns` 两表（`SqliteStorage.appendConversationTurn`/`listRecentSignals`/`listConversationTurns`，按 learner+topic 归并、`turn_index` 稳定排序）；新增共享编排 `src/engines/conversation.ts`（`recordTurn`：**先读历史**→解析信号→更新画像→记录事件→生成动作→落库本轮），**收敛三处重复实现**（`/api/chat`、`/api/voice/chat`、MCP `chat_socratic`）并顺带修掉 MCP 侧 `updateFromSignal` 漏 `await`；`config.conversation.maxHistory`（`CONVERSATION_MAX_HISTORY`，默认 20）给历史长度设界 | patch | 中 | ✅ 已修复（8 项进程内验证全过、`tsc --noEmit`/`npm run build` 通过；含 `app.inject()` HTTP 端到端回归「连续两轮 confused → hint」） |
| （开始开发后登记） | <br /> | <br />  | <br /> | <br />        | <br />  | <br /> |

> 纪律：修复前生成上下文地图缩小读取范围；根因关卡（WHAT→WHY 是否消除）；一次改一点逐步验证；默认原位修复；连续修复失败≥2次或架构性缺陷才评估重写并登记于此。

***

## 5. 执行纪律

1. 先批判性审查本计划，疑问先问用户。
2. 转 todo 逐个执行，每任务按验收标准验证。
3. 遇阻塞（缺依赖/测试失败/指令不清）立即停下询问。
4. 新出现的待确认/重大决策写入第 3 节。
5. 完成一任务即更新状态。

***

## 6. 目录结构（最终）

```
socratic-tutor/
├── docs/            # requirements / design(overall,detail,debate) / development-plan
├── knowledge/skills/  # book-to-skill 产物（RAG 源）
├── data/            # SQLite、画像、反思、音频（运行时）
├── src/             # web / engines / providers / storage / scheduler / mcp
├── public/          # 前端
├── scripts/         # dev/build
├── README.md / README_cn.md / HANDOFF.md
└── package.json
```

***

本开发计划为代码开发的执行依据，随迭代更新。已发布目标 0.5.0（IT15 向量 RAG）、0.6.0（IT16 多节点 + 流量录制）、0.7.0（IT17 MCP Server）均已完成。后续规划见迭代版本记录。
