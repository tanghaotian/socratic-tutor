# Socratic Tutor — Conversational Socratic Teaching Agent

> Version: 0.7.0 · Stack: Node.js / TypeScript

A local personal-learning companion agent built around **Socratic dialogue**. Instead of handing out answers, it guides you to think, explore, and construct understanding through layered questions. It **adapts the teaching plan** based on the quality of each answer and your study frequency, and supports **weekly self-reflection upgrades** plus **book/paper/video summarization & retrieval**.

## Core Mechanisms

1. **Socratic Dialogue**: open question → focus → cognitive conflict → self-evaluation → timely hint; with voice support (Phase 1 non-realtime, Phase 2 realtime & interruptible, interaction modeled on Doubao).
2. **Self-Reflection (吾日三省吾身)**: a scheduled weekly scan (default Fri 19:00, configurable) generates an *Upgrade Requirement Document*; only after your confirmation does it proceed to design → development plan → update.
3. **Resource Summarization & Retrieval**: web search, structured summaries of books/papers/videos, and `book-to-skill` processing that outputs markdown into the local `knowledge/skills/`.
4. **Study Plan + Review stages**: generates a per-topic study plan md (goals/depth/sessions) → generates a review md (4-dimension weighted score) at period end; confirming the review **cross-checks** it against the plan to update the profile, and **N consecutive low weighted scores** auto-trigger **anchor reflection** (LLM/heuristic anchor correction + audit log); both stages' generation capabilities evolve via **combined weighted eval** (plan+review joint A/B scoring), applied only when approved.

## Architecture Overview

```
Presentation (Web UI / IDE Agent) → API (HTTP/WS/MCP) → Application (teaching/profile/reflection/resource engines)
   → Adapters (LLM/ASR/TTS/Reminder Provider) → Infrastructure (storage/RAG/scheduler)
```

- **Switchable models (config-driven)**: LLM Provider abstraction over a single OpenAI-compatible registry `config.llm.models`. Doubao / DeepSeek / Qwen are built in (`LLM_PROVIDER=qwen` → `qwen3.7-flash`); any extra OpenAI-compatible model is added via a single JSON entry in `LLM_EXTRA_MODELS` — **zero code**.
- **Dedicated eval judge**: low-volume, so a stronger model can be used for LLM-as-Judge via `JUDGE_PROVIDER`/`JUDGE_MODEL` (defaults to the main model).
- **Deployable + IDE integration**: local web service first; containerization reserved; an **MCP Server (0.7.0)** exposes the same capabilities to IDEs (TRAE first, Claude Code later) over HTTP JSON-RPC at `POST /mcp` — `chat_socratic`, `get_learner_profile`, `trigger_reflection`, `confirm_upgrade`, `summarize_resource`, `plan_generate`, `review_generate`.
- **AI localization boundary**: a Python sidecar plugin slot is reserved to avoid future refactoring around local models.
- **Scale-out + traffic replay recording (0.6.0)**: Web is stateless and horizontally scalable; scheduled jobs (reflection/eval) run under distributed locks (single-process / file / SQLite backends) so only one instance executes; a pluggable recording layer saves every real chat/voice turn into frozen threads (`data/threads/`) and a sampled golden dataset for replay-based eval (no Kafka in MVP).

## Project Structure

```
docs/              requirements, design (overall/detail/debate), development plan, reflections
knowledge/skills/  book-to-skill output markdown (local knowledge source)
src/               web / engines / providers / storage / scheduler / mcp
public/            frontend
data/              SQLite, profiles, reflections, audio (runtime)
scripts/           dev / build / voice self-check / seed threads
```

## Install & Run

```bash
npm install                  # install dependencies
npm test                     # run unit tests
cp .env.example .env         # configure DOUBAO_API_KEY, LLM_PROVIDER, etc.
npm run dev                  # start local web service
```

**Helper commands** (both require `npm run build` first):

```bash
npm run seed:threads         # write built-in teaching seed threads to data/threads/ (eval cold start, idempotent)
npm run voice:verify         # voice pipeline self-check (TTS→ASR round trip; reports Mock mode when unconfigured)
```

See `scripts/dev.ps1` / `scripts/dev.sh` for detailed commands.

> **Real-data backfill**: the seed threads in `data/threads/` are hand-written teaching samples, present only
> so the evaluation pipeline runs out of the box. Real conversations accumulate automatically via the recording
> layer; seed files may be deleted at any time, and the eval thresholds/sampling size should be re-validated
> against real data.

**Progress**: IT1-IT8 (Phase 1, 0.1.0) ✅ · **Phase 1.5 (0.2.0)** ✅ IT9 engine skill plug-in (teaching/profile engines consume pluggable skills via StrategyManager: stacking / enable-disable / snapshot) · IT10 self-built eval gate (snapshot baseline + rubric LLM-as-Judge + A/B win rate, weekly sampling & monthly full replay via `data/threads` + `data/evals`, unified EvalManager interface switchable to promptfoo/agentbench/deepeval; report written to `data/evals/<date>_<engine>_<kind>.json`, verdict needs human approval) ✅ · **IT10b knowledge→skill generation (§8.2.1) ✅** (classifies book-to-skill md as teaching methodology → LLM extracts rules → generates a pure-TS capability skill draft + doc, registers its factory for the eval gate, runs `runEvalGate` for a verdict; a `skillGen` option lets the weekly reflection scan `knowledge/skills/` and record drafts into the report) ✅ · **use step ✅** (`applyGeneratedSkill` persists a confirmed draft to `data/skills/active.json`; engines are assembled via `createEngineManagerFromRegistry` so applied skills are stacked on the default core set at startup) ✅ · **IT10c when-to-use + combo (0.3.0) ✅** (each skill now declares its trigger scenario via `SkillWhen` — concepts/signals/consecutive/profileMasteryLt — gated by `StrategyManager.run`; same-`exclusiveGroup` skills compete via `canHandle` so only the best match runs when combining multiple skills; generated skills embed `when`, `docs/skills/*.md` get a "when-to-use" section) · **IT12 Provider 切换 + 独立评测 judge ✅** (LLM Provider 配置化自动注册（`config.llm.models` 单一事实来源，可经 `LLM_EXTRA_MODELS` 零代码追加任意 OpenAI 兼容模型）；`JUDGE_PROVIDER`/`JUDGE_MODEL` 可让周报/月报评测用独立更强 judge，未配则跟随主模型) · **IT13 0.3.0 wrap-up + real closed loop ✅ (2026-09-09)** (version unified to 0.3.0 across package.json / lock / startup print / READMEs; git initialized with `.gitignore` for `.env`/`data`; with a real Qwen key the whole chain runs on the real LLM: chat signal/action, weekly reflection export, and `skillGen` classify + rule extraction, and the eval gate scored with a real judge (`judgeDegraded=false`). A Feynman-technique skill was generated from `knowledge/skills/feynman-technique.md`, verdict **accepted** (all rubric dimensions +0.5, A/B 3:0, candidate mean 9.1), then applied to `data/skills/active.json` — engine assembly auto-stacks it on `socratic.core` at startup) · **IT14 0.4.0 study plan + review stages ✅ (2026-09-09)** (new `src/engines/plans/`: StudyPlanEngine generates per-topic plan md (draft→confirmed); ReviewEngine scores (goal completion / signal accuracy / frequency / mastery change, weighted & normalized) and generates review md; confirming a review triggers **cross-check** (achieved topics get profile mastery/interest bumps) and **anchor reflection** (N consecutive weighted scores below `PLAN_ANCHOR_THRESHOLD` auto-correct the anchor via LLM first, heuristic fallback, audit to SQLite + `data/anchors/<reviewId>.md`); `eval.ts` provides the **combined weighted eval gate** (plan/review 2-dimension LLM-as-Judge + weighted A/B; `accepted` writes `data/plans/active.json`, assembled over defaults at startup); Web gains `/api/plan/*`, `/api/review/*`, `/api/strategy/*` routes plus a "Plan/Review" frontend tab; chat & voice turns now record learning events for scoring. 88 tests pass, `npm run build` green) · **IT15 0.5.0 vector RAG ✅ (2026-09-09)** (sqlite-vec + Node 24 `node:sqlite` semantic retrieval; `RAG_BACKEND=hybrid` vector-KNN + keyword fallback, embedding reuses the main LLM and auto-degrades if `EMBEDDING_MODEL` unset; wired into `/api/resource/search`; 95 tests pass) · **IT16 0.6.0 multi-node + traffic replay recording ✅ (2026-09-10)** (new `src/tracing/`: `ReplayRecorder` saves every chat/voice turn to `data/threads/` as frozen threads (idempotent), `sampleThreads` does layered sampling with failure-first + semantic dedup, and `GoldenDataset` maintains a golden set readable by `loadFrozenThreads`; new `src/locks/` distributed locks (single-process / file / SQLite) wrap the reflection/eval schedulers so concurrent instances execute a task only once; recording is a pluggable middleware defaulting on, no Kafka in MVP. 105 tests pass, `npm run build` green) · **IT17 0.7.0 MCP Server ✅ (2026-09-10)** (new `src/mcp/`: a shared `McpContext` reuses the same engines/storage/providers as the Web assembly; `POST /mcp` on the existing Fastify server speaks MCP JSON-RPC 2.0 — `tools/list` returns the 7 tools wrapped as `{ tools: [...] }` with strict `additionalProperties:false` input schemas and `tools/call` dispatches `chat_socratic`/`get_learner_profile`/`trigger_reflection`/`confirm_upgrade`/`summarize_resource`/`plan_generate`/`review_generate` with the same semantics as the Web APIs and standard error codes (MethodNotFound/InvalidParams/etc.); disabled via `MCP_ENABLED=false` without affecting the Web service. 120 tests pass, `npm run build` green).

## Roadmap

- **Phase 1 (target 0.1.0)**: text Socratic dialogue + profile/adaptive + reflection loop + web UI + non-realtime voice + resource engine/basic RAG
- **Phase 1.5 (target 0.2.0)**: pluggable engine skills (teaching/profile adapt via multiple addable/adjustable skills) + self-built evaluation gate (snapshot baseline + rubric scoring + A/B win rate, weekly sampling & monthly full replay, human approval; unified eval interface switchable across frameworks)
- **Phase 1.6 (target 0.4.0)**: study plan + review stages (plan/review md + cross-check + weighted anchor reflection + combined weighted evolution eval) ✅
- **0.5.0 (done)**: vector RAG / semantic retrieval — sqlite-vec (zero new infra, keywords kept as fallback backend) ✅
- **0.6.0 (done)**: multi-node deployment + production traffic replay recording — stateless web scale-out + SQLite primary/replica + distributed lock for scheduled jobs + pluggable recording layer (no Kafka in MVP) ✅
- **0.7.0 (done)**: MCP Server — expose `chat_socratic` / `get_learner_profile` / `trigger_reflection` / `confirm_upgrade` / `summarize_resource` / `plan_generate` / `review_generate` via HTTP JSON-RPC at `POST /mcp` (shared `src/mcp`) ✅
- **Phase 2**: realtime two-way voice + containerized deployment
- **Phase 3**: reminder channel expansion (email / WeChat) + RAG optimization

See [docs/development-plan.md](docs/development-plan.md) for details.