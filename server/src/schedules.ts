import type { EngineContext } from './context.js';
import { SOURCE_NAMES } from './sources/index.js';

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
const MAX_BATCH = 200;
const MAX_DAILY_LIMIT = 10_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DELAY_MS = 1100;

export interface SourceScheduleRow {
  source: string;
  enabled: number;
  interval_minutes: number;
  batch_limit: number;
  daily_limit: number;
  tags: string | null;
  next_mode: 'head' | 'backfill';
  head_id: string | null;
  cursor: string | null;
  backfill_done: number;
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface SourceScheduleDto {
  source: string;
  enabled: boolean;
  intervalMinutes: number;
  batchLimit: number;
  dailyLimit: number;
  tags: string | null;
  nextMode: 'head' | 'backfill';
  headId: string | null;
  cursor: string | null;
  backfillDone: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
  failureCount: number;
  dailyUsed: number;
}

export interface SourceSchedulePatch {
  enabled?: boolean;
  intervalMinutes?: number;
  batchLimit?: number;
  dailyLimit?: number;
  tags?: string | null;
  /** Start the archive walk from the newest post again. */
  reset?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function iso(value: Date): string {
  return value.toISOString();
}

function numericId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function utcDayStart(now: Date): string {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return iso(start);
}

function nextUtcDay(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCMinutes(5);
  return iso(next);
}

function dailyUsed(ctx: EngineContext, source: string, now: Date): number {
  const row = ctx.sqlite
    .prepare(
      `SELECT COALESCE(SUM(seen), 0) AS used
       FROM source_runs
       WHERE auto = 1 AND source = ? AND created_at >= ?`,
    )
    .get(source, utcDayStart(now)) as { used: number };
  return row.used;
}

function dto(ctx: EngineContext, row: SourceScheduleRow, now: Date): SourceScheduleDto {
  return {
    source: row.source,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    batchLimit: row.batch_limit,
    dailyLimit: row.daily_limit,
    tags: row.tags,
    nextMode: row.next_mode,
    headId: row.head_id,
    cursor: row.cursor,
    backfillDone: row.backfill_done === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    failureCount: row.failure_count,
    dailyUsed: dailyUsed(ctx, row.source, now),
  };
}

export function ensureSourceSchedules(ctx: EngineContext, now = new Date()): void {
  const timestamp = iso(now);
  const insert = ctx.sqlite.prepare(
    `INSERT OR IGNORE INTO source_schedules
      (source, enabled, interval_minutes, batch_limit, daily_limit, tags, next_mode,
       head_id, cursor, backfill_done, next_run_at, last_run_at, last_error, failure_count,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'head', NULL, NULL, 0, ?, NULL, NULL, 0, ?, ?)`,
  );
  for (const source of SOURCE_NAMES) {
    insert.run(
      source,
      ctx.config.sourceAutoEnabled ? 1 : 0,
      clamp(ctx.config.sourceAutoIntervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
      clamp(ctx.config.sourceAutoBatch, 1, MAX_BATCH),
      clamp(ctx.config.sourceAutoDailyLimit, 0, MAX_DAILY_LIMIT),
      ctx.config.sourceAutoTags ?? null,
      timestamp,
      timestamp,
      timestamp,
    );
  }
}

export function listSourceSchedules(ctx: EngineContext, now = new Date()): SourceScheduleDto[] {
  ensureSourceSchedules(ctx, now);
  const rows = ctx.sqlite
    .prepare('SELECT * FROM source_schedules ORDER BY source ASC')
    .all() as SourceScheduleRow[];
  return rows.map((row) => dto(ctx, row, now));
}

/**
 * Queue one automatic run per due source. A run is skipped while the same
 * source still has a queued/running job, when the daily processed-post budget
 * is exhausted, or when the schedule is disabled.
 */
export function tickSourceSchedules(ctx: EngineContext, now = new Date()): number {
  ensureSourceSchedules(ctx, now);
  const due = ctx.sqlite
    .prepare(
      `SELECT * FROM source_schedules
       WHERE enabled = 1 AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(iso(now)) as SourceScheduleRow[];

  let started = 0;
  for (const row of due) {
    const active = ctx.sqlite
      .prepare(
        "SELECT id FROM source_runs WHERE source = ? AND status IN ('queued', 'running') LIMIT 1",
      )
      .get(row.source) as { id: number } | undefined;
    if (active) continue;

    const used = dailyUsed(ctx, row.source, now);
    if (row.daily_limit > 0 && used >= row.daily_limit) {
      ctx.sqlite
        .prepare(
          `UPDATE source_schedules
           SET last_error = ?, next_run_at = ?, updated_at = ?
           WHERE source = ?`,
        )
        .run(
          `daily cap reached: ${used}/${row.daily_limit} posts processed`,
          nextUtcDay(now),
          iso(now),
          row.source,
        );
      continue;
    }

    const mode: 'head' | 'backfill' =
      row.next_mode === 'backfill' && row.cursor && row.backfill_done === 0 ? 'backfill' : 'head';
    const sinceId = mode === 'head' ? row.head_id : null;
    const cursor = mode === 'backfill' ? row.cursor : null;
    // Do not overshoot the daily budget by a whole batch at the end of the day.
    const batch =
      row.daily_limit > 0
        ? Math.min(row.batch_limit, Math.max(1, row.daily_limit - used))
        : row.batch_limit;

    const create = ctx.sqlite.transaction(() => {
      const inserted = ctx.sqlite
        .prepare(
          `INSERT INTO source_runs
            (source, tags, limit_count, page, page_size, delay_ms, status, auto, mode,
             since_id, cursor, created_at)
           VALUES (?, ?, ?, 1, ?, ?, 'queued', 1, ?, ?, ?, ?)`,
        )
        .run(row.source, row.tags, batch, batch, DEFAULT_DELAY_MS, mode, sinceId, cursor, iso(now));
      const runId = Number(inserted.lastInsertRowid);
      ctx.sqlite
        .prepare(
          'INSERT INTO source_run_logs (run_id, level, message, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          runId,
          'info',
          `Auto-queued ${mode} run (batch ${batch}${sinceId ? `, since #${sinceId}` : ''}${
            cursor ? `, cursor #${cursor}` : ''
          }).`,
          iso(now),
        );
      ctx.sqlite
        .prepare(
          `UPDATE source_schedules
           SET next_run_at = ?, last_run_at = ?, last_error = NULL, updated_at = ?
           WHERE source = ?`,
        )
        .run(
          iso(new Date(now.getTime() + row.interval_minutes * 60_000)),
          iso(now),
          iso(now),
          row.source,
        );
      ctx.sqlite
        .prepare('INSERT INTO jobs (kind, payload, run_at, created_at) VALUES (?, ?, ?, ?)')
        .run('source_import', JSON.stringify({ runId }), iso(now), iso(now));
      return runId;
    });
    create();
    started += 1;
  }
  return started;
}

/**
 * Feed a completed auto run back into its schedule. Manual runs do nothing
 * here, so an operator can still run one-off imports without moving watermarks.
 */
export function applySourceRunResult(ctx: EngineContext, runId: number, now = new Date()): void {
  const run = ctx.sqlite
    .prepare(
      `SELECT auto, source, mode, status, newest_origin_id, next_cursor, error
       FROM source_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        auto: number;
        source: string;
        mode: string;
        status: string;
        newest_origin_id: string | null;
        next_cursor: string | null;
        error: string | null;
      }
    | undefined;
  if (!run || run.auto !== 1) return;

  const schedule = ctx.sqlite
    .prepare('SELECT * FROM source_schedules WHERE source = ?')
    .get(run.source) as SourceScheduleRow | undefined;
  if (!schedule) return;

  let headId = schedule.head_id;
  let cursor = schedule.cursor;
  let backfillDone = schedule.backfill_done === 1;
  let nextMode: 'head' | 'backfill' = schedule.next_mode;
  let failureCount = schedule.failure_count;
  let lastError = schedule.last_error;
  let nextRunAt = schedule.next_run_at;

  if (run.status === 'completed') {
    failureCount = 0;
    lastError = null;
    const newest = numericId(run.newest_origin_id);
    const currentHead = numericId(headId);
    if (newest !== null && (currentHead === null || newest > currentHead)) {
      headId = run.newest_origin_id;
    }

    if (run.mode === 'head') {
      // The first head page also seeds the archive walk with its oldest id.
      if (run.next_cursor) cursor = run.next_cursor;
      if (!cursor) backfillDone = true;
      nextMode = backfillDone ? 'head' : 'backfill';
    } else if (run.mode === 'backfill') {
      if (!run.next_cursor || run.next_cursor === cursor) {
        backfillDone = true;
      } else {
        cursor = run.next_cursor;
      }
      nextMode = 'head';
    } else {
      nextMode = 'head';
    }

    nextRunAt = iso(new Date(now.getTime() + schedule.interval_minutes * 60_000));
  } else if (run.status === 'failed') {
    failureCount += 1;
    lastError = run.error ?? 'source import failed';
    const backoff = Math.min(
      schedule.interval_minutes * 60_000 * 2 ** Math.min(failureCount, 5),
      MAX_BACKOFF_MS,
    );
    nextRunAt = iso(new Date(now.getTime() + backoff));
  } else {
    // A moderator cancelled this auto run. Resume normally next interval.
    nextRunAt = iso(new Date(now.getTime() + schedule.interval_minutes * 60_000));
  }

  ctx.sqlite
    .prepare(
      `UPDATE source_schedules
       SET head_id = ?, cursor = ?, backfill_done = ?, next_mode = ?, failure_count = ?,
           last_error = ?, next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE source = ?`,
    )
    .run(
      headId,
      cursor,
      backfillDone ? 1 : 0,
      nextMode,
      failureCount,
      lastError,
      nextRunAt,
      iso(now),
      iso(now),
      run.source,
    );
}

export function updateSourceSchedule(
  ctx: EngineContext,
  source: string,
  patch: SourceSchedulePatch,
  now = new Date(),
): SourceScheduleDto | null {
  ensureSourceSchedules(ctx, now);
  const current = ctx.sqlite
    .prepare('SELECT * FROM source_schedules WHERE source = ?')
    .get(source) as SourceScheduleRow | undefined;
  if (!current) return null;

  const enabled = patch.enabled ?? current.enabled === 1;
  const intervalMinutes = clamp(
    patch.intervalMinutes ?? current.interval_minutes,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
  );
  const batchLimit = clamp(patch.batchLimit ?? current.batch_limit, 1, MAX_BATCH);
  const dailyLimit = clamp(patch.dailyLimit ?? current.daily_limit, 0, MAX_DAILY_LIMIT);
  const tags =
    patch.tags === undefined
      ? current.tags
      : patch.tags === null || !patch.tags.trim()
        ? null
        : patch.tags.trim();
  const reset = patch.reset === true;

  const nextRunAt = enabled ? iso(now) : current.next_run_at;
  ctx.sqlite
    .prepare(
      `UPDATE source_schedules
       SET enabled = ?, interval_minutes = ?, batch_limit = ?, daily_limit = ?, tags = ?,
           next_mode = ?, head_id = ?, cursor = ?, backfill_done = ?, next_run_at = ?,
           last_error = ?, failure_count = ?, updated_at = ?
       WHERE source = ?`,
    )
    .run(
      enabled ? 1 : 0,
      intervalMinutes,
      batchLimit,
      dailyLimit,
      tags,
      reset ? 'head' : current.next_mode,
      reset ? null : current.head_id,
      reset ? null : current.cursor,
      reset ? 0 : current.backfill_done,
      nextRunAt,
      enabled ? null : current.last_error,
      enabled ? 0 : current.failure_count,
      iso(now),
      source,
    );

  const row = ctx.sqlite
    .prepare('SELECT * FROM source_schedules WHERE source = ?')
    .get(source) as SourceScheduleRow;
  return dto(ctx, row, now);
}
