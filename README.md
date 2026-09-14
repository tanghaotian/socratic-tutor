# Socratic Tutor

English | [中文](README.zh.md)

A self-hosted learning companion that teaches by **asking instead of answering**. It runs as a local web
service, keeps a learner profile, and adapts its teaching plan to how well you actually answer.

The core mechanism is Socratic dialogue: open question → focused follow-up → cognitive conflict →
self-evaluation → hint. Every answer you give is classified into a signal (`correct` / `confused` /
`mistake` / `divergent`), which updates your profile and drives the next question. The project also
carries a self-evaluation loop: it periodically reviews its own teaching quality and proposes upgrades
that **only take effect after you confirm them**.

- **Version**: 0.7.0
- **Stack**: Node.js 22+ / TypeScript, Fastify, SQLite (built-in `node:sqlite`), single-file Vue 3 frontend
- **Status**: personal/local use. Single user (`local-user`), no multi-tenant auth, no container image yet.

Review the [known limitations](#known-limitations) before real use — several pieces are honest
scaffolding rather than finished features.

## Features

- **Adaptive Socratic dialogue** — answer signals drive question type, depth, and prompt level.
- **Learner profile & adaptation** — mastery, mistakes/strengths, interest weights, learning speed.
- **Study plan + review stages** — per-topic plan md → period-end review md with a 4-dimension weighted
  score → cross-check updates the profile; repeated low scores trigger **anchor reflection**.
- **Weekly self-reflection** — scheduled job generates an *Upgrade Requirement Document* for your approval.
- **Resource engine** — structured summaries of books/papers/videos, `book-to-skill` markdown into
  `knowledge/skills/`, plus retrieval over that local knowledge (keyword, or hybrid with embeddings).
- **Voice (Phase 1, non-realtime)** — upload a recording → ASR → dialogue → TTS. Falls back to Mock when
  unconfigured, and says so out loud.
- **MCP server** — exposes the same capabilities to MCP clients (IDE agents) over Streamable HTTP at `POST /mcp`.
- **Evaluation gate** — frozen-thread replay + rubric LLM-as-Judge + A/B win rate, gating any skill or
  strategy change behind a machine verdict **and** human approval.

## Architecture

```
Presentation (Web UI / MCP client)
  → API (Fastify REST / MCP over HTTP JSON-RPC)
    → Engines (teaching · profile · reflection · resource · plans · skillgen · eval)
      → Providers (LLM · ASR · TTS · search · reminder)
        → Infrastructure (SQLite · RAG / vectors · scheduler · locks · tracing)
```

Two design decisions matter more than the layer diagram:

- **Engine skills are pluggable.** Teaching and profile engines consume `CapabilitySkill` modules through a
  `StrategyManager` (stacking, enable/disable, snapshots, `when`-gating, exclusive groups). The default
  `socratic.core` keeps legacy behavior intact; generated skills stack on top.
- **Model-agnostic.** One OpenAI-compatible registry (`config.llm.models`) covers Doubao, DeepSeek and Qwen;
  any other compatible endpoint is added with a single JSON entry in `LLM_EXTRA_MODELS` — no code change.

## Quick start

**Prerequisites**: Node.js **22 or newer** (the storage layer uses the built-in `node:sqlite` module; Node 18
is not sufficient despite what `package.json` said before 0.7.0 — the declared engine is now aligned to 22).

```sh
git clone git@github.com:tanghaotian/socratic-tutor.git
cd socratic-tutor
npm install
cp .env.example .env
npm run dev
```

`cp .env.example .env` copies the template you then fill in with an API key (see [Configuration](#configuration)).
`npm run dev` starts the web service at `http://127.0.0.1:5173`.

To run the compiled output instead:

```sh
npm run build
npm start
```

`npm run dev` runs TypeScript directly via `tsx` in watch mode; `npm run build` compiles with `tsc` and
`npm start` runs the compiled output.

### Try it

1. Open `http://127.0.0.1:5173`.
2. On the **对话** tab, enter a topic (e.g. `微积分`) and answer a question — short or hesitant answers are
   classified `confused`; two in a row escalate from a focused follow-up to a hint.
3. Check **学习画像** to see the profile the dialogue has built.
4. On **计划/复盘** generate a plan, confirm it, then generate a review.

## Configuration

All configuration is environment variables, read from `.env` (not committed). The essential ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `doubao` | Active model id; one of the built-in `doubao` / `deepseek` / `qwen`, or any id from `LLM_EXTRA_MODELS`. |
| `QWEN_API_KEY` | — | Key for the Qwen (DashScope compatible) endpoint. |
| `DOUBAO_API_KEY` | — | Key for the Doubao (Volcengine Ark) endpoint. |
| `DEEPSEEK_API_KEY` | — | Key for the DeepSeek endpoint. |
| `LLM_EXTRA_MODELS` | — | JSON array of `{id, baseURL, apiKey, model}` — adds any OpenAI-compatible model without code changes. |
| `JUDGE_PROVIDER` / `JUDGE_MODEL` | follow main model | Stronger model used only as the evaluation judge. |
| `PORT` | `5173` | Web service port (bound to `127.0.0.1`). |
| `STORAGE_DIR` | `./data` | SQLite database, plans, reviews, reflections, audio. |
| `KNOWLEDGE_DIR` | `./knowledge/skills` | `book-to-skill` markdown and RAG source. |
| `RAG_BACKEND` | `keyword` | `keyword`, or `hybrid` for semantic retrieval (also needs `EMBEDDING_MODEL`). |
| `CONVERSATION_MAX_HISTORY` | `20` | Turns of history feeding consecutive-signal decisions (bounded to limit token growth). |
| `MCP_ENABLED` | `true` | Register the MCP endpoint at `/mcp`. |
| `REFLECTION_CRON` | `0 19 * * 5` | Weekly self-reflection schedule (Fri 19:00). |
| `TRACING_ENABLED` | `true` | Record real conversations as frozen threads for replay-based evaluation. |

See [`.env.example`](.env.example) for the complete list (voice, plan/review weights, eval cadence,
multi-node deployment, distributed locks).

> **Voice is Mock unless configured.** Without `ASR_APPID` / `ASR_ACCESS_TOKEN` / `TTS_APPID` /
> `TTS_ACCESS_TOKEN`, ASR returns placeholder text and TTS returns silence. The service prints a startup
> warning and `/api/voice/chat` returns `voiceDegraded: true` — it is never silently faked.

## MCP integration

The MCP server is mounted on the same port as the web service (Streamable HTTP, protocol `2025-06-18`,
`MCP_ENABLED=false` to disable). Handshake, version negotiation, `Mcp-Session-Id` sessions, `ping`,
`DELETE`, and Origin validation are implemented per spec.

Seven tools are exposed:

| Tool | Purpose |
| --- | --- |
| `chat_socratic` | One Socratic turn: classify signal → update profile → return a teaching action. |
| `get_learner_profile` | Read the learner profile (optionally per topic). |
| `trigger_reflection` | Generate the weekly upgrade document (draft). |
| `confirm_upgrade` | Confirm a reflection draft. |
| `summarize_resource` | Structured summary of a book/paper/video into `knowledge/skills/`. |
| `plan_generate` | Generate a study plan draft for a topic. |
| `review_generate` | Generate a review draft with 4-dimension weighted scores. |

Read tools are safe to call directly. **Tools that change state (`confirm_upgrade`) keep human
confirmation as a required step** — that separation is deliberate, not incidental.

## Development

```sh
npm run dev
npm run build
npm start
npm test
npx tsc --noEmit
```

`npm test` runs the `node:test` suites in `test/`; `npx tsc --noEmit` is a type check with no output.

Helper scripts (run `npm run build` first):

```sh
npm run seed:threads
npm run voice:verify
npm run verify:bug004
npm run assess:sample
```

`seed:threads` writes the built-in teaching seed threads into `data/threads/` (idempotent) and
`voice:verify` checks the TTS→ASR round trip, reporting Mock mode when unconfigured. `verify:bug004`
asserts conversation-history behavior in-process. `assess:sample` is the evaluation-sample readiness gate
(exit `1` while real data is insufficient).

`assess:sample` exists because the evaluation thresholds were originally calibrated against only three
frozen threads, while the design target is 20–30 sampled per week. It counts **real** threads separately
from the hand-written seed threads (`t-seed-*`) and exits non-zero while real data is insufficient — seed
data must never be used to calibrate thresholds, because it would produce a falsely passing verdict.

### Project structure

```
src/
  web/          Fastify REST routes + static frontend hosting
  mcp/          MCP server (Streamable HTTP, JSON-RPC, tool registry)
  engines/      socratic · profile · reflection · resource · plans · skills · skillgen · eval
  providers/    LLM (OpenAI-compatible) · ASR · TTS · search · reminder
  storage/      SQLite (profiles, plans, reviews, conversations, events) · RAG · vectors
  scheduler/    weekly reflection + weekly/monthly evaluation cron
  locks/        distributed locks (in-process · file · SQLite)
  tracing/      recording, sampling, golden dataset, replay
public/         single-file Vue 3 frontend
test/           node:test suites
docs/           requirements, design, development plan, assessment notes
knowledge/skills/   book-to-skill output (runtime knowledge source)
data/           runtime state — SQLite, plans, reviews, audio, threads (not committed)
```

### Testing notes

Tests use the built-in `node:test` runner. Route-level behavior is covered through Fastify's
`app.inject()` rather than by calling handlers directly — a regression in v0.7.0 returned `{}` from
`POST /mcp` while all function-level tests passed, so endpoint-level assertions are required for new routes.

## Evaluation and self-evolution

The project treats "did this change actually help?" as a measurable question rather than a matter of taste:

1. Real conversations are recorded as **frozen threads** (`data/threads/`).
2. A change is described as a candidate **snapshot** (active skill set / strategy configuration).
3. Baseline and candidate are replayed over the same threads and scored by an LLM judge against a rubric,
   with an A/B win rate (`data/evals/<date>_<engine>_<kind>.json`).
4. The verdict is advisory (`accepted` / `rejected` / `needs_review`) — **applying it is a human step**.

Generated capability skills follow the same path: knowledge markdown → LLM rule extraction → generated
TypeScript skill draft → evaluation gate → human approval → `data/skills/active.json`.

## Known limitations

These are stated plainly because they affect whether the project is useful to you:

- **Evaluation is under-sampled.** Thresholds were validated against very little real data. Run
  `npm run assess:sample` to see the current state.
- **Recorded threads are single-turn.** The recording layer stores one user/agent pair, so frozen threads do
  not exercise consecutive-signal logic during replay.
- **Voice is unverified end-to-end** without real ASR/TTS credentials (Mock mode by default).
- **Single user, no auth.** `learnerId` is hardcoded to `local-user`; there is no login or tenant isolation.
- **No container image.** Containerized deployment is planned, not built.
- **No license file yet.** The repository does not currently declare a license; treat it as all-rights-reserved
  until one is added.

## Roadmap

- **0.1.0** — text dialogue, profile/adaptation, reflection loop, web UI, non-realtime voice, basic RAG
- **0.2.0** — pluggable engine skills, self-built evaluation gate
- **0.3.0** — `when`-to-use gating, skill combination/arbitration, provider switching, dedicated judge
- **0.4.0** — study plan + review stages, cross-check, anchor reflection, combined weighted evolution
- **0.5.0** — vector RAG / semantic retrieval (`sqlite-vec`)
- **0.6.0** — multi-node deployment, distributed locks, traffic replay recording
- **0.7.0** — MCP server (Streamable HTTP)
- **Next** — realtime two-way voice, containerized deployment, reminder channel expansion, RAG optimization

See [docs/development-plan.md](docs/development-plan.md) for the full plan and per-iteration records, and
[docs/design/agentification-assessment.md](docs/design/agentification-assessment.md) for the cost/benefit
assessment of moving the orchestration layer to an LLM-driven agent loop.
