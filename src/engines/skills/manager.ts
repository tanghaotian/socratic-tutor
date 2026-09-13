import type {
  ActiveSkill,
  CapabilitySkill,
  SkillContext,
  SkillEngine,
  SkillResult,
} from './types.js';
import type { TeachingAction } from '../socratic.js';

/**
 * 策略管理器（IT9，detail.md §8.2）。
 * 管理引擎的能力策略 skill：注册/替换、启停、列表、快照、按序叠加执行。
 * 引擎只经 run 消费，不感知具体 skill 实现。
 */
export class StrategyManager {
  /** key = `${engine}:${id}` */
  private skills = new Map<string, CapabilitySkill>();
  private enabled = new Map<string, boolean>();
  /** 注册顺序（叠加执行顺序） */
  private order: string[] = [];

  private key(engine: SkillEngine, id: string): string {
    return `${engine}:${id}`;
  }

  /** 新增或替换 skill（按 engine+id）；新增默认启用，替换保持原启停状态 */
  register(s: CapabilitySkill): void {
    const k = this.key(s.engine, s.id);
    if (!this.skills.has(k)) {
      this.order.push(k);
      this.enabled.set(k, true);
    }
    this.skills.set(k, s);
  }

  enable(engine: SkillEngine, id: string): void {
    const k = this.key(engine, id);
    if (!this.skills.has(k)) throw new Error(`skill 未注册: ${k}`);
    this.enabled.set(k, true);
  }

  disable(engine: SkillEngine, id: string): void {
    const k = this.key(engine, id);
    if (!this.skills.has(k)) throw new Error(`skill 未注册: ${k}`);
    this.enabled.set(k, false);
  }

  /** 某引擎当前激活的 skill 列表 */
  list(engine: SkillEngine): ActiveSkill[] {
    return this.listAll().filter((s) => s.engine === engine && s.enabled);
  }

  /** 全部注册 skill（含禁用） */
  listAll(): ActiveSkill[] {
    return this.order.map((k) => {
      const s = this.skills.get(k)!;
      return { id: s.id, engine: s.engine, version: s.version, enabled: this.enabled.get(k) ?? false };
    });
  }

  /** 快照：导出某引擎当前激活配置（供评测回测对照基线） */
  snapshot(engine: SkillEngine): ActiveSkill[] {
    return this.list(engine);
  }

  /**
   * 按注册顺序叠加执行某引擎的激活 skill。
   * 1) when 门控：仅执行 `when(ctx)` 为 true 的 skill（未声明 when = 始终适用）。
   * 2) 组合编排：互斥组（exclusiveGroup）内多 skill 命中时，仅保留 canHandle 最高者。
   * 3) 叠加：上一个 socratic skill 产出的动作注入下一 skill 的 prevAction；最终由调用方取最后一个动作。
   */
  async run(engine: SkillEngine, ctx: SkillContext): Promise<SkillResult[]> {
    // 候选 = 引擎匹配 + 启用 + when 命中
    const candidates: CapabilitySkill[] = [];
    for (const k of this.order) {
      const s = this.skills.get(k)!;
      if (s.engine !== engine || !(this.enabled.get(k) ?? false)) continue;
      if (s.when && !s.when(ctx)) continue;
      candidates.push(s);
    }

    // 互斥组内仅保留 canHandle 最高者
    const bestByGroup = new Map<string, CapabilitySkill>();
    for (const s of candidates) {
      if (!s.exclusiveGroup) continue;
      const cur = bestByGroup.get(s.exclusiveGroup);
      const curScore = cur ? (cur.canHandle ? cur.canHandle(ctx) : 1) : -Infinity;
      const sScore = s.canHandle ? s.canHandle(ctx) : 1;
      if (!cur || sScore > curScore) bestByGroup.set(s.exclusiveGroup, s);
    }

    // 依次执行（仍按注册顺序），跳过被互斥剔除的候选
    const results: SkillResult[] = [];
    let prevAction: TeachingAction | undefined;
    for (const s of candidates) {
      if (s.exclusiveGroup && bestByGroup.get(s.exclusiveGroup) !== s) continue;
      const res = await s.apply({ ...ctx, prevAction });
      results.push(res);
      if (res.engine === 'socratic' && res.action) prevAction = res.action;
    }
    return results;
  }
}
