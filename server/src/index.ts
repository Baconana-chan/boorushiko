import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertConfig, ConfigError } from './config-validation.js';
import { createDb } from './db.js';
import { healthSnapshot } from './health.js';
import { cleanupStaging, processJobs, processSourceJobs } from './jobs.js';
import { Logger } from './logger.js';
import { runMaintenance } from './maintenance.js';
import { createMirrors } from './mirrors/index.js';
import { HealthMonitor, telegramSender } from './monitor.js';
import { tickSourceSchedules } from './schedules.js';

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = new Logger(config.logLevel, { app: 'boorushiko' });
  assertConfig(config, log);
  const { sqlite, db } = createDb(config.dbPath);
  const mirrors = createMirrors(config);
  const ctx = { sqlite, db, config, mirrors, log };
  const app = buildApp(ctx);

  const jobsTimer = setInterval(() => {
    void processJobs(ctx).catch((error) => log.error('job worker failed', { err: error }));
  }, config.jobsIntervalMs);
  jobsTimer.unref();

  const sourceTimer = setInterval(() => {
    void processSourceJobs(ctx).catch((error) => log.error('source worker failed', { err: error }));
  }, 2000);
  sourceTimer.unref();
  void processSourceJobs(ctx).catch((error) => log.error('source worker failed', { err: error }));

  const scheduleTimer = setInterval(() => {
    try {
      tickSourceSchedules(ctx);
    } catch (error) {
      log.error('source scheduler failed', { err: error });
    }
  }, 30_000);
  scheduleTimer.unref();
  try {
    tickSourceSchedules(ctx);
  } catch (error) {
    log.error('source scheduler failed', { err: error });
  }

  const cleanupTimer = setInterval(
    () => {
      void cleanupStaging(config.stagingDir, config.stagingTtlMinutes);
    },
    10 * 60 * 1000,
  );
  cleanupTimer.unref();

  // Backups and the weekly VACUUM keep their own persisted schedule, so calling
  // this at startup is cheap and only runs work that is actually due.
  const maintenanceTimer = setInterval(() => {
    void runMaintenance(ctx).catch((error) => log.error('maintenance failed', { err: error }));
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  // The first due run happens after listen(), so a weekly VACUUM never delays
  // the port opening during a deploy.

  const monitor = config.monitorEnabled
    ? new HealthMonitor({
        diskMinBytes: config.monitorDiskMinMb * 1024 * 1024,
        queueMax: config.monitorQueueMax,
        rssMaxBytes: config.monitorRssMaxMb * 1024 * 1024,
        cooldownMinutes: config.alertCooldownMinutes,
        backupsEnabled: config.backupEnabled,
        backupIntervalHours: config.backupIntervalHours,
        send:
          config.telegramAlertBotToken && config.telegramAlertChatId
            ? telegramSender(config.telegramAlertBotToken, config.telegramAlertChatId)
            : null,
      })
    : null;

  const checkHealth = async (): Promise<void> => {
    if (!monitor) return;
    try {
      const result = await monitor.check(await healthSnapshot(ctx));
      for (const alert of result.sent) log.warn('health alert', { alert });
      for (const alert of result.failed) log.error('health alert delivery failed', { alert });
    } catch (error) {
      log.error('health check failed', { err: error });
    }
  };

  const monitorTimer = monitor
    ? setInterval(() => void checkHealth(), config.monitorIntervalMinutes * 60_000)
    : undefined;
  monitorTimer?.unref();

  const shutdown = async () => {
    clearInterval(jobsTimer);
    clearInterval(sourceTimer);
    clearInterval(scheduleTimer);
    clearInterval(cleanupTimer);
    clearInterval(maintenanceTimer);
    if (monitorTimer) clearInterval(monitorTimer);
    await app.close();
    sqlite.close();
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  if (mirrors.size === 0) {
    log.warn('no mirrors configured; uploads stay pending until MIRRORS is set');
  }

  await app.listen({ port: config.port, host: config.host });
  log.info('engine listening', {
    url: `http://${config.host}:${config.port}`,
    nodeEnv: config.nodeEnv,
    db: config.dbPath,
    staging: config.stagingDir,
    mirrors: [...mirrors.keys()],
    backups: config.backupEnabled ? config.backupDir : 'off',
    monitor: config.monitorEnabled ? `${config.monitorIntervalMinutes}m` : 'off',
    alerts: config.telegramAlertChatId ? 'telegram' : 'log-only',
  });
  void runMaintenance(ctx).catch((error) => log.error('maintenance failed', { err: error }));
}

main().catch((error) => {
  // Configuration mistakes are expected operator errors: print the list without a stack.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
