import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Sqlite } from './db.js';

/**
 * Snapshots are made with `VACUUM INTO`, not by copying files: the result is a
 * transactionally consistent, already defragmented database even while the
 * engine is serving requests or a WAL file is growing.
 */
const BACKUP_PREFIX = 'boorushiko-';

export const BACKUP_JOB = 'backup';
export const VACUUM_JOB = 'vacuum';

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupResult {
  path: string;
  bytes: number;
  /** Posts visible in the snapshot; proves the copy opened and queried. */
  posts: number;
  removed: string[];
}

export interface MaintenanceState {
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps the WAL from growing on the shared disk; TRUNCATE also frees it. */
export function checkpointWal(sqlite: Sqlite): {
  busy: number;
  log: number;
  checkpointed: number;
} {
  const rows = sqlite.pragma('wal_checkpoint(TRUNCATE)') as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  return rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
}

/** Opens the snapshot read-only and checks both integrity and a real query. */
export function verifyBackup(path: string): { posts: number } {
  const copy = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new BackupError(`backup integrity check failed: ${String(integrity)}`);
    }
    const row = copy.prepare('SELECT COUNT(*) AS count FROM posts').get() as {
      count: number;
    };
    return { posts: row.count };
  } finally {
    copy.close();
  }
}

/** Newest `keep` snapshots survive; a failed unlink must not fail the backup. */
export async function pruneBackups(dir: string, keep: number, current?: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files = entries
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
    .sort();
  const removed: string[] = [];
  while (files.length > Math.max(keep, 1)) {
    const name = files[0]!;
    if (current && join(dir, name) === current) break;
    files.shift();
    await unlink(join(dir, name)).catch(() => undefined);
    removed.push(name);
  }
  return removed;
}

export async function createBackup(options: {
  sqlite: Sqlite;
  dbPath: string;
  dir: string;
  keep: number;
}): Promise<BackupResult> {
  if (options.dbPath === ':memory:') {
    throw new BackupError('cannot back up an in-memory database');
  }
  await mkdir(options.dir, { recursive: true });

  // ISO timestamps sort chronologically, which is what pruneBackups relies on.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(options.dir, `${BACKUP_PREFIX}${stamp}.db`);

  checkpointWal(options.sqlite);
  options.sqlite.prepare('VACUUM INTO ?').run(target);

  const { posts } = verifyBackup(target);
  const info = await stat(target);
  const removed = await pruneBackups(options.dir, options.keep, target);
  return { path: target, bytes: info.size, posts, removed };
}

export function maintenanceState(sqlite: Sqlite, name: string): MaintenanceState | null {
  const row = sqlite
    .prepare(
      `SELECT last_started_at AS startedAt, last_finished_at AS finishedAt, last_error AS error
       FROM maintenance_runs WHERE name = ?`,
    )
    .get(name) as MaintenanceState | undefined;
  return row ?? null;
}

export function maintenanceDue(sqlite: Sqlite, name: string, intervalMs: number): boolean {
  const state = maintenanceState(sqlite, name);
  if (!state) return true;
  const last = Date.parse(state.finishedAt ?? state.startedAt);
  return !Number.isFinite(last) || Date.now() - last >= intervalMs;
}

export function markMaintenanceStarted(sqlite: Sqlite, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO maintenance_runs (name, last_started_at, last_finished_at, last_error)
       VALUES (?, ?, NULL, NULL)
       ON CONFLICT(name) DO UPDATE SET
         last_started_at = excluded.last_started_at,
         last_error = NULL`,
    )
    .run(name, new Date().toISOString());
}

export function markMaintenanceFinished(sqlite: Sqlite, name: string): void {
  sqlite
    .prepare('UPDATE maintenance_runs SET last_finished_at = ?, last_error = NULL WHERE name = ?')
    .run(new Date().toISOString(), name);
}

/**
 * A failure still advances the schedule: retrying every tick (ten minutes)
 * would flood the logs and keep hammering a full disk. The error stays visible
 * in `/healthz` and the log until the next attempt.
 */
export function markMaintenanceFailed(sqlite: Sqlite, name: string, error: unknown): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(`UPDATE maintenance_runs SET last_finished_at = ?, last_error = ? WHERE name = ?`)
    .run(now, messageOf(error).slice(0, 1000), name);
}
