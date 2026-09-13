import type { AppConfig } from '../config.js';
import type {
  ASRProvider,
  LLMProvider,
  ReminderProvider,
  SearchProvider,
  TTSProvider,
} from './interfaces.js';
import type { EmbeddingProvider } from './llm/embeddings.js';
import { OpenAICompatEmbedding } from './llm/embeddings.js';
import { LLMRegistry } from './llm/registry.js';
import { WebReminderProvider } from './reminder/web.js';
import { DoubaoASRProvider } from './asr/doubao.js';
import { MockASRProvider } from './asr/mock.js';
import { DoubaoTTSProvider } from './tts/doubao.js';
import { MockTTSProvider } from './tts/mock.js';
import { MockSearchProvider } from './search/mock.js';

/** 全局 Provider 容器：由配置构建并持有各注册表/实例 */
export class ProviderContainer {
  readonly llm: LLMRegistry;
  private reminders: Map<string, ReminderProvider>;
  private asr?: ASRProvider;
  private tts?: TTSProvider;
  private search?: SearchProvider;
  private embedding: EmbeddingProvider | null = null;

  constructor(private cfg: AppConfig) {
    this.llm = new LLMRegistry(cfg.llm);
    // 提醒 Provider 注册表（web 优先，email/wechat 预留）
    this.reminders = new Map();
    this.reminders.set('web', new WebReminderProvider(cfg.storage.dir));
    // 语音 Provider：优先豆包（需真实 key），未配置时用本地 Mock 占位保证联调链路可跑
    this.asr = cfg.voice.asrAppid && cfg.voice.asrToken
      ? new DoubaoASRProvider({
          appid: cfg.voice.asrAppid,
          accessToken: cfg.voice.asrToken,
          resourceId: cfg.voice.asrResourceId,
        })
      : new MockASRProvider();
    this.tts = cfg.voice.ttsAppid && cfg.voice.ttsToken
      ? new DoubaoTTSProvider({
          appid: cfg.voice.ttsAppid,
          accessToken: cfg.voice.ttsToken,
          cluster: cfg.voice.ttsCluster,
          voiceType: cfg.voice.ttsVoiceType,
        })
      : new MockTTSProvider();
    this.search = new MockSearchProvider(); // Search 待真实服务（如 Tavily/SerpAPI）接入，暂无 key 用 Mock
  }

  /** 获取当前 LLM Provider */
  getLLM(): LLMProvider {
    return this.llm.get();
  }

  /** 获取评测 judge 用 LLM Provider（可独立于主模型配置更强模型） */
  getJudge(): LLMProvider {
    return this.llm.getJudge();
  }

  /** 按 id 获取提醒 Provider；未注册则回退 web */
  getReminder(id?: string): ReminderProvider {
    const key = id ?? this.cfg.reflection.reminderProvider;
    return this.reminders.get(key) ?? this.reminders.get('web')!;
  }

  /** 获取当前 ASR Provider（未配置真实服务时返回 Mock 占位） */
  getASR(): ASRProvider {
    return this.asr!;
  }

  /** 获取当前 TTS Provider（未配置真实服务时返回 Mock 占位） */
  getTTS(): TTSProvider {
    return this.tts!;
  }

  /**
   * 语音链路是否处于占位降级模式（ASR 或 TTS 任一走 Mock）。
   * 产品化可见性：未配置真实语音凭据时，启动与接口响应都会显式暴露该状态，
   * 避免「听到静音/拿到占位文本」被误认为真实识别结果。
   */
  isVoiceDegraded(): boolean {
    return this.getASR().id.startsWith('mock') || this.getTTS().id.startsWith('mock');
  }

  /** 获取当前联网检索 Provider（未配置真实服务时返回 Mock 占位） */
  getSearch(): SearchProvider {
    return this.search!;
  }

  listLLM(): string[] {
    return this.llm.list();
  }

  /**
   * 获取文本嵌入 Provider（IT15 向量 RAG）。
   * 未配置 EMBEDDING_MODEL → 返回 null（RAG 降级纯关键词）；已配置则复用
   * EMBEDDING_PROVIDER（默认跟随主 LLM provider）所在模型的 baseURL/apiKey，
   * 以 EMBEDDING_MODEL 为嵌入模型构建 OpenAI 兼容 embedding。
   */
  getEmbedding(): EmbeddingProvider | null {
    if (this.embedding !== null) return this.embedding; // 缓存（含 null）
    const em = this.cfg.embedding;
    if (!em.model) {
      this.embedding = null;
      return null;
    }
    const pid = em.provider || this.cfg.llm.provider;
    const base = this.cfg.llm.models.find((m) => m.id === pid);
    if (!base || !base.apiKey) {
      console.warn(`[embedding] 未找到 ${pid} 的有效 apiKey，向量 RAG 降级为纯关键词`);
      this.embedding = null;
      return null;
    }
    this.embedding = new OpenAICompatEmbedding(
      { id: `${pid}:embedding`, apiKey: base.apiKey, baseURL: base.baseURL, model: em.model },
      em.dim,
    );
    return this.embedding;
  }
}

/** 单例容器（应用启动时初始化一次） */
let _container: ProviderContainer | null = null;

export function initProviders(cfg: AppConfig): ProviderContainer {
  _container = new ProviderContainer(cfg);
  return _container;
}

export function getProviders(): ProviderContainer {
  if (!_container) throw new Error('Provider 容器尚未初始化，请先调用 initProviders()');
  return _container;
}