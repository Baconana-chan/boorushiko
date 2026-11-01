import { constants } from 'node:fs';
import { access, mkdir, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { maintenanceState, messageOf } from './backup.js';
import type { EngineContext } from './context.js';

export interface MirrorHealth {
  host: string;
  total: number;
  ok: number;
  dead: number;
}

export interface MaintenanceHealth {
  name: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface HealthSnapshot {
  ok: boolean;
  posts: number;
  uptimeSeconds: number;
  db: { ok: boolean; posts: number; error?: string };
  disk: { path: string | null; freeBytes: number | null; totalBytes: number | null };
  memory: { rssBytes: number };
  queue: { pending: number; sourcePending: number };
  mirrors: MirrorHealth[];
  maintenance: MaintenanceHealth[];
}

export interface ReadySnapshot {
  ok: boolean;
  db: { ok: boolean; error?: string };
  staging: { ok: boolean; path: string; error?: string };
}

function diskPath(ctx: EngineContext): string | null {
  // In-memory databases (tests) have no directory; report the working disk.
  if (ctx.config.dbPath === ':memory:') return process.cwd();
  return dirname(ctx.config.dbPath);
}

function count(sqlite: EngineContext['sqlite'], sql: string): number {
  const row = sqlite.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Real database counters; a broken file must report, not throw. */
function databaseHealth(ctx: EngineContext): HealthSnapshot['db'] {
  try {
    return {
      ok: true,
      posts: count(ctx.sqlite, 'SELECT COUNT(*) AS count FROM posts'),
    };
  } catch (error) {
    return { ok: false, posts: 0, error: messageOf(error) };
  }
}

function mirrorHealth(ctx: EngineContext): MirrorHealth[] {
  let rows: MirrorHealth[] = [];
  try {
    rows = ctx.sqlite
      .prepare(
        `SELECT host,
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
                COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) AS dead
         FROM post_sources
         GROUP BY host`,
      )
      .all() as MirrorHealth[];
  } catch {
    return [];
  }
  const byHost = new Map(rows.map((row) => [row.host, row]));
  const result = [...ctx.mirrors.keys()].map(
    (host) => byHost.get(host) ?? { host, total: 0, ok: 0, dead: 0 },
  );
  // A host removed from MIRRORS keeps its history visible for diagnosis.
  for (const row of rows) {
    if (!ctx.mirrors.has(row.host)) result.push(row);
  }
  return result;
}

function maintenanceHealth(ctx: EngineContext): MaintenanceHealth[] {
  const result: MaintenanceHealth[] = [];
  for (const name of ['backup', 'vacuum']) {
    try {
      const state = maintenanceState(ctx.sqlite, name);
      if (state) result.push({ name, ...state });
    } catch {
      // A broken database already shows up in `db.ok`; do not hide it here.
    }
  }
  return result;
}

export async function healthSnapshot(ctx: EngineContext): Promise<HealthSnapshot> {
  const db = databaseHealth(ctx);
  const path = diskPath(ctx);
  let disk: HealthSnapshot['disk'] = { path, freeBytes: null, totalBytes: null };
  if (path) {
    try {
      const info = await statfs(path);
      disk = {
        path,
        freeBytes: info.bavail * info.bsize,
        totalBytes: info.blocks * info.bsize,
      };
    } catch {
      // The path may not exist yet on a fresh install; null means "unknown".
    }
  }

  let pending = 0;
  let sourcePending = 0;
  try {
    pending = count(ctx.sqlite, 'SELECT COUNT(*) AS count FROM jobs WHERE locked_at IS NULL');
    sourcePending = count(
      ctx.sqlite,
      "SELECT COUNT(*) AS count FROM jobs WHERE locked_at IS NULL AND kind = 'source_import'",
    );
  } catch {
    // Reported through db.ok.
  }

  return {
    ok: db.ok,
    posts: db.posts,
    uptimeSeconds: Math.round(process.uptime()),
    db,
    disk,
    // pm2 restarts at 400 MB; the monitor warns before that hammer drops.
    memory: { rssBytes: process.memoryUsage().rss },
    queue: { pending, sourcePending },
    mirrors: mirrorHealth(ctx),
    maintenance: maintenanceHealth(ctx),
  };
}

/** Readiness for a deploy/proxy check: database answers and staging is writable. */
export async function readySnapshot(ctx: EngineContext): Promise<ReadySnapshot> {
  let db: ReadySnapshot['db'];
  try {
    ctx.sqlite.prepare('SELECT 1').get();
    db = { ok: true };
  } catch (error) {
    db = { ok: false, error: messageOf(error) };
  }

  let staging: ReadySnapshot['staging'];
  try {
    await mkdir(ctx.config.stagingDir, { recursive: true });
    await access(ctx.config.stagingDir, constants.W_OK);
    staging = { ok: true, path: ctx.config.stagingDir };
  } catch (error) {
    staging = { ok: false, path: ctx.config.stagingDir, error: messageOf(error) };
  }

  return { ok: db.ok && staging.ok, db, staging };
}
