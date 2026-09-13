import type { EvalRequest, EvalReport } from './types.js';

/** 统一评测后端（detail.md §9.1）：self-built | promptfoo | agentbench | deepeval */
export interface EvalBackend {
  id: string;
  run(req: EvalRequest): Promise<EvalReport>;
}

/**
 * 统一评测接口（IT10，detail.md §9.1）。
 * 注册多个后端，按配置切换当前后端；引擎/门禁只经 run 消费，不感知具体框架。
 */
export class EvalManager {
  private backends = new Map<string, EvalBackend>();
  private active: string | null = null;

  register(b: EvalBackend): void {
    this.backends.set(b.id, b);
    if (!this.active) this.active = b.id;
  }

  /** 切换当前评测后端（未注册则抛错） */
  setActive(id: string): void {
    if (!this.backends.has(id)) throw new Error(`评测后端未注册: ${id}`);
    this.active = id;
  }

  get activeId(): string | null {
    return this.active;
  }

  listBackends(): string[] {
    return [...this.backends.keys()];
  }

  async run(req: EvalRequest): Promise<EvalReport> {
    if (!this.active) throw new Error('评测后端未设置');
    const backend = this.backends.get(this.active)!;
    return backend.run(req);
  }
}
