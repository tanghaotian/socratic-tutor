import type { AppConfig } from '../config.js';
import type { ProviderContainer } from '../providers/index.js';
import type { ReminderProvider } from '../providers/interfaces.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import type { SocraticEngine } from '../engines/socratic.js';
import type { SignalParser } from '../engines/signal.js';
import type { ProfileEngine } from '../engines/profile.js';
import type { ReflectionEngine } from '../engines/reflection.js';
import type { ResourceEngine } from '../engines/resource.js';
import type { StudyPlanEngine, ReviewEngine } from '../engines/plans/index.js';
import type { PlanReviewStrategy } from '../engines/plans/types.js';

/**
 * MCP 工具可复用的应用上下文（IT17）。
 * 与 Web 服务共用同一批引擎/存储/provider，MCP 是对外封装，不重复实现业务逻辑。
 */
export interface McpContext {
  cfg: AppConfig;
  providers: ProviderContainer;
  store: SqliteStorage;
  learnerId: string;
  parser: SignalParser;
  profile: ProfileEngine;
  socratic: SocraticEngine;
  reflection: ReflectionEngine;
  resource: ResourceEngine;
  planEngine: StudyPlanEngine;
  reviewEngine: ReviewEngine;
  remind: ReminderProvider;
  strategies: { plan: PlanReviewStrategy; review: PlanReviewStrategy };
}