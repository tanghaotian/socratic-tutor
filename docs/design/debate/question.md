# 待决策问题：Socratic Tutor 技术栈与架构选型

- 决策主题：**整体技术栈、后端框架与实时语音迭代路径的选择**

- 影响范围：全项目——直接影响后续所有开发任务、部署形态与 IDE 集成方式。

## 背景

Socratic Tutor 是一个本地运行的对话式教学 Agent，需求要点：

- 基于大模型 API（默认豆包 Doubao，可切换）。本地 Web 服务优先，预留可部署与 IDE(MCP/TRAE) 集成。

- Phase 1 先做**非实时语音**（ASR→文本→TTS），后续迭代 Phase 2 **实时双向语音（可打断）**。

- 需定时任务（每周反思）、本地存储（画像/对话/反思 + md 知识库/RAG）、学习画像与自适应。

## 候选方案

- **方案 A：Python + FastAPI + 轻量 LLM SDK 封装**

  - ASR/TTS/LLM Provider 生态成熟（openai 风格 SDK、whisper 等），RAG 库(如 llama-index / chromadb)，FastAPI 有 WebSocket 便于 Phase 2 实时语音。后端+AI 同语言，演进 Phase 2 阻力小。

- **方案 B：Node.js/TypeScript + Express/Fastify + 统一 LLM Provider 接口**

  - 与 Web 前端同语言，本机已有便携 Node v24.19.0，前后端共享类型；前端生态强。实时语音用 WebSocket/WebRTC 可行。但 AI/RAG/ASR 生态略逊于 Python。

- **方案 C：Node 后端 + 前端框架(Vue/React) + 预留 Python 微服务（混合）**

  - 兼顾前端体验与 AI 生态，但架构更重，部署复杂度高，与"优先快速跑通核心"矛盾。

## 评判标准

1. **可行性/速度**：能否最快跑通 Phase 1 教学核心与非实时语音。
2. **Phase 2 演进**：实时双向语音扩展阻力小。
3. **部署/IDE 集成**：本地 Web + MCP(TRAE) + 容器化顺畅。
4. **维护复杂度**：单语言 vs 混合，长期维护成本。
5. **本机环境适配**：充分利用已有工具链（便携 Node v24、Python 是否可用待确认）。

