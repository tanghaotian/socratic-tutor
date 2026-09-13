import { config } from './config.js';
import { initProviders } from './providers/index.js';
import { Scheduler } from './scheduler/index.js';
import { EvalScheduler } from './scheduler/eval-cron.js';
import { createDistributedLock } from './locks/index.js';
import { startWebServer } from './web/index.js';

/**
 * Socratic Tutor 应用入口。
 * 初始化 Provider 容器与存储，启动 Web 服务并挂载每周反思调度与评测调度。
 */
export async function bootstrap(): Promise<void> {
  const providers = initProviders(config);
  const llm = providers.getLLM();
  const { SqliteStorage } = await import('./storage/sqlite.js');
  const store = new SqliteStorage(`${config.storage.dir}/learner.db`);

  console.log(`[socratic-tutor v0.7.0]`);
  console.log(`  环境: ${config.env}`);
  console.log(`  可用 LLM Provider: ${providers.listLLM().join(', ')}`);
  console.log(`  当前 LLM Provider: ${config.llm.provider}`);
  console.log(`  评测 judge: ${config.llm.judge.provider || config.llm.provider} / ${config.llm.judge.model || '(跟随主模型)'}`);
  console.log(`  反思调度(cron): ${config.reflection.cron}（默认周五 19:00）`);
  console.log(`  评测后端: ${config.eval.backend}`);
  console.log(`  知识库目录: ${config.storage.knowledgeDir}`);
  console.log(`  计划/复盘: 锚定触发 ${config.plan.anchorStreak} 次加权分 < ${config.plan.anchorThreshold}`);

  // 产品化可见性：语音链路降级必须显式告警，避免 Mock 被误认为真实识别
  console.log(`  语音 ASR: ${providers.getASR().id} / TTS: ${providers.getTTS().id}`);
  if (providers.isVoiceDegraded()) {
    console.warn(
      '  ⚠ 语音链路为 Mock 占位模式（未配置 ASR_APPID/ASR_ACCESS_TOKEN、TTS_APPID/TTS_ACCESS_TOKEN）：' +
        '识别结果为占位文本、合成音频为静音，仅供链路联调，请勿用于真实教学。',
    );
  }

  // 每周反思调度（IT16：多节点下经分布式锁防重复执行）
  const lock = createDistributedLock(config.deploy);
  const scheduler = new Scheduler(llm, store, providers.getReminder(config.reflection.reminderProvider), lock);
  scheduler.startWeekly();

  // 评测调度（每周抽样 + 每月全量），使用独立 judge 模型（若配置），占锁防重复
  const evalScheduler = new EvalScheduler(providers.getJudge(), lock);
  evalScheduler.start();

  // Web 服务
  await startWebServer(config, providers);
}

// 直接执行入口（dev/start 均运行本文件）
void bootstrap();