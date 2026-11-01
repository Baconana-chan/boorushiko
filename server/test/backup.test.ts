import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createBackup, maintenanceState, verifyBackup } from '../src/backup.js';
import type { Sqlite } from '../src/db.js';
import { runMaintenance } from '../src/maintenance.js';
import { createTestContext, seedPost } from './helpers.js';

const contexts: Array<{ sqlite: Sqlite; root: string }> = [];

afterEach(() => {
  for (const { sqlite, root } of contexts.splice(0)) {
    // Windows keeps the database file locked until the connection is closed.
    try {
      sqlite.close();
    } catch {
      // The unhealthy-database test may have closed it already.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function fileContext(overrides: Partial<Config> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'boorushiko-backup-'));
  const context = createTestContext({
    dbPath: join(root, 'booru.db'),
    backupDir: join(root, 'backups'),
    backupKeep: 2,
    backupIntervalHours: 24,
    backupEnabled: true,
    maintenanceVacuumDays: 0,
    ...overrides,
  });
  contexts.push({ sqlite: context.ctx.sqlite, root });
  return { ...context, root };
}

describe('database backups', () => {
  it('writes a verified snapshot and keeps only the latest copies', async () => {
    const { ctx } = fileContext();
    seedPost(ctx, { md5: '1'.repeat(32), tags: ['solo'] });
    seedPost(ctx, { md5: '2'.repeat(32), tags: ['solo'] });

    const first = await createBackup({
      sqlite: ctx.sqlite,
      dbPath: ctx.config.dbPath,
      dir: ctx.config.backupDir,
      keep: 2,
    });
    expect(existsSync(first.path)).toBe(true);
    expect(first.posts).toBe(2);
    expect(first.bytes).toBeGreaterThan(0);
    expect(verifyBackup(first.path).posts).toBe(2);

    await createBackup({
      sqlite: ctx.sqlite,
      dbPath: ctx.config.dbPath,
      dir: ctx.config.backupDir,
      keep: 2,
    });
    const third = await createBackup({
      sqlite: ctx.sqlite,
      dbPath: ctx.config.dbPath,
      dir: ctx.config.backupDir,
      keep: 2,
    });

    expect(third.removed).toHaveLength(1);
    expect(readdirSync(ctx.config.backupDir)).toHaveLength(2);
  });

  it('runs the scheduled backup once per interval and records it', async () => {
    const { ctx } = fileContext();
    seedPost(ctx, { md5: '3'.repeat(32) });

    const first = await runMaintenance(ctx);
    expect(first.backup?.posts).toBe(1);
    const state = maintenanceState(ctx.sqlite, 'backup');
    expect(state?.finishedAt).toBeTruthy();
    expect(state?.error).toBeNull();

    const second = await runMaintenance(ctx);
    expect(second.backup).toBeNull();
  });

  it('records a failed backup instead of crashing the timer', async () => {
    const { ctx } = createTestContext({ backupEnabled: true, maintenanceVacuumDays: 0 });
    const result = await runMaintenance(ctx);

    expect(result.backup).toBeNull();
    expect(maintenanceState(ctx.sqlite, 'backup')?.error).toMatch(/in-memory/);
  });

  it('checkpoints and vacuums when due, then waits for the window', async () => {
    const { ctx } = fileContext({ maintenanceVacuumDays: 7 });

    const first = await runMaintenance(ctx);
    expect(first.vacuumed).toBe(true);
    expect(maintenanceState(ctx.sqlite, 'vacuum')?.finishedAt).toBeTruthy();

    const second = await runMaintenance(ctx);
    expect(second.vacuumed).toBe(false);
  });
});
