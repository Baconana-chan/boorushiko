import {
  BACKUP_JOB,
  VACUUM_JOB,
  checkpointWal,
  createBackup,
  maintenanceDue,
  markMaintenanceFailed,
  markMaintenanceFinished,
  markMaintenanceStarted,
  type BackupResult,
} from './backup.js';
import type { EngineContext } from './context.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface MaintenanceTickResult {
  backup: BackupResult | null;
  vacuumed: boolean;
}

/**
 * Called on a short timer (and once at startup). Every job has a persisted
 * schedule row, so a pm2 restart neither skips a daily backup nor repeats a
 * weekly VACUUM it already ran.
 */
export async function runMaintenance(ctx: EngineContext): Promise<MaintenanceTickResult> {
  const log = ctx.log.child({ module: 'maintenance' });
  const result: MaintenanceTickResult = { backup: null, vacuumed: false };

  if (
    ctx.config.backupEnabled &&
    maintenanceDue(ctx.sqlite, BACKUP_JOB, ctx.config.backupIntervalHours * HOUR_MS)
  ) {
    markMaintenanceStarted(ctx.sqlite, BACKUP_JOB);
    try {
      const backup = await createBackup({
        sqlite: ctx.sqlite,
        dbPath: ctx.config.dbPath,
        dir: ctx.config.backupDir,
        keep: ctx.config.backupKeep,
      });
      markMaintenanceFinished(ctx.sqlite, BACKUP_JOB);
      result.backup = backup;
      log.info('database backup written', {
        path: backup.path,
        bytes: backup.bytes,
        posts: backup.posts,
        removed: backup.removed,
      });
    } catch (error) {
      markMaintenanceFailed(ctx.sqlite, BACKUP_JOB, error);
      log.error('database backup failed', { err: error, dir: ctx.config.backupDir });
    }
  }

  if (
    ctx.config.maintenanceVacuumDays > 0 &&
    maintenanceDue(ctx.sqlite, VACUUM_JOB, ctx.config.maintenanceVacuumDays * DAY_MS)
  ) {
    markMaintenanceStarted(ctx.sqlite, VACUUM_JOB);
    try {
      // Synchronous by design: a small archive means seconds of write pause once
      // a week, and the WAL checkpoint keeps the file from growing unbounded.
      const checkpoint = checkpointWal(ctx.sqlite);
      ctx.sqlite.exec('VACUUM');
      ctx.sqlite.pragma('optimize');
      markMaintenanceFinished(ctx.sqlite, VACUUM_JOB);
      result.vacuumed = true;
      log.info('database vacuumed', {
        checkpointed: checkpoint.checkpointed,
        walFrames: checkpoint.log,
        busy: checkpoint.busy,
      });
    } catch (error) {
      markMaintenanceFailed(ctx.sqlite, VACUUM_JOB, error);
      log.error('database vacuum failed', { err: error });
    }
  }

  return result;
}
