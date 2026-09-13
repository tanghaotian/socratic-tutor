import type { LLMProvider } from '../interfaces.js';
import type { AppConfig } from '../../config.js';
import { OpenAICompatProvider } from './openai-compat.js';

export type LLMProviderId = string;

/**
 * LLM Provider 注册表：集中管理各 Provider 实例，支持运行时切换。
 * 全部模型取自 `config.llm.models`（OpenAI 兼容清单），由 OpenAICompatProvider 统一承载，
 * 通过 `LLM_EXTRA_MODELS` 增加模型即可零代码接入。采用懒加载：仅按需初始化当前/被访问的
 * Provider，未配置 API Key 的 Provider 在首次访问时才抛错，避免启动即失败。
 */
export class LLMRegistry {
  private providers = new Map<string, () => LLMProvider>();
  private instances = new Map<string, LLMProvider>();
  private currentId: string;

  constructor(private cfg: AppConfig['llm']) {
    for (const m of cfg.models) {
      this.register(m.id, () => new OpenAICompatProvider(m.id, m));
    }
    this.currentId = cfg.provider;
  }

  register(id: string, factory: () => LLMProvider): void {
    this.providers.set(id, factory);
  }

  /** 获取当前默认 Provider（懒初始化） */
  get(): LLMProvider {
    return this.getById(this.currentId);
  }

  getById(id: string): LLMProvider {
    const factory = this.providers.get(id);
    if (!factory) throw new Error(`未知 LLM Provider: ${id}`);
    let inst = this.instances.get(id);
    if (!inst) {
      inst = factory();
      this.instances.set(id, inst);
    }
    return inst;
  }

  /** 运行时切换当前 Provider */
  use(id: string): void {
    const factory = this.providers.get(id);
    if (!factory) throw new Error(`未知 LLM Provider: ${id}`);
    this.currentId = id;
  }

  /**
   * 获取评测 judge 用的 LLM Provider。
   * judge 优先使用 `llm.judge` 配置（可独立指定 provider + 更强模型，仅周报/月报调用）。
   * 未配置 judge.model → 跟随主模型所在 provider 的默认 model。
   * 配置了 judge.model → 以该 model 覆盖重建（仍 OpenAI 兼容），懒初始化并缓存。
   */
  getJudge(): LLMProvider {
    const jid = this.cfg.judge.provider || this.currentId;
    const jm = this.cfg.judge.model || '';
    if (jm) {
      const base = this.cfg.models.find((m) => m.id === jid);
      if (base && base.apiKey) {
        const cacheKey = `${jid}:judge`;
        let judge = this.instances.get(cacheKey);
        if (!judge) {
          judge = new OpenAICompatProvider(jid, {
            apiKey: base.apiKey,
            baseURL: base.baseURL,
            model: jm,
          });
          this.instances.set(cacheKey, judge);
        }
        return judge;
      }
    }
    return this.getById(jid);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}