import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EngineContext } from './context.js';
import type { Logger } from './logger.js';
import { applySourceRunResult } from './schedules.js';
import { createSource, sourceOptions } from './sources/index.js';
import { importFromSource, type ImportStats } from './sources/importer.js';

export interface MirrorUploadPayload {
  postId: number;
  host: string;
  deliveryPath: string;
  thumbPath?: string;
  mime: string;
  bytes: number;
  filename: string;
  /** Set by the worker so cleanup can exclude the job currently running. */
  jobId?: number;
}

export interface SourceImportPayload {
  runId: number;
}

interface JobRow {
  id: number;
  kind: string;
  payload: string;
  run_at: string;
  attempts: number;
  locked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface SourceRunRow {
  id: number;
  source: string;
  tags: string | null;
  limit_count: number;
  page: number;
  page_size: number;
  delay_ms: number;
  status: string;
  cancel_requested: number;
  auto: number;
  mode: string;
  since_id: string | null;
  cursor: string | null;
}

const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function enqueueJob(
  sqlite: EngineContext['sqlite'],
  kind: string,
  payload: unknown,
  runAt = new Date(),
): void {
  sqlite
    .prepare('INSERT INTO jobs (kind, payload, run_at, created_at) VALUES (?, ?, ?, ?)')
    .run(kind, JSON.stringify(payload), runAt.toISOString(), new Date().toISOString());
}

function claimJob(sqlite: EngineContext['sqlite'], kind: string): JobRow | undefined {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  return sqlite
    .prepare(
      `UPDATE jobs SET locked_at = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE kind = ? AND run_at <= ? AND (locked_at IS NULL OR locked_at < ?)
         ORDER BY id
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(now, kind, now, stale) as JobRow | undefined;
}

function retryLater(ctx: EngineContext, job: JobRow, error: string): void {
  if (job.attempts >= MAX_ATTEMPTS) {
    ctx.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    ctx.log.warn('job dropped after too many attempts', {
      kind: job.kind,
      jobId: job.id,
      attempts: job.attempts,
      error,
    });
    return;
  }
  const backoffMs = Math.min(2 ** job.attempts * 15_000, 60 * 60 * 1000);
  ctx.sqlite
    .prepare('UPDATE jobs SET locked_at = NULL, last_error = ?, run_at = ? WHERE id = ?')
    .run(error.slice(0, 500), new Date(Date.now() + backoffMs).toISOString(), job.id);
}

async function handleMirrorUpload(ctx: EngineContext, payload: MirrorUploadPayload): Promise<void> {
  const mirror = ctx.mirrors.get(payload.host);
  if (!mirror) throw new Error(`mirror not configured: ${payload.host}`);

  const now = new Date().toISOString();
  const uploaded = await mirror.upload({
    path: payload.deliveryPath,
    filename: payload.filename,
    mime: payload.mime,
    bytes: payload.bytes,
  });

  ctx.sqlite
    .prepare(
      `INSERT INTO post_sources (post_id, host, remote_id, url, role, status, created_at)
       SELECT ?, ?, ?, ?, 'serve', 'ok', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM post_sources WHERE post_id = ? AND host = ? AND url = ?
       )`,
    )
    .run(
      payload.postId,
      payload.host,
      uploaded.remoteId ?? null,
      uploaded.url,
      now,
      payload.postId,
      payload.host,
      uploaded.url,
    );

  if (payload.thumbPath) {
    const thumb = await mirror.upload({
      path: payload.thumbPath,
      filename: 'thumb.webp',
      mime: 'image/webp',
      bytes: 0,
    });
    ctx.sqlite
      .prepare(
        `INSERT INTO post_variants (post_id, kind, url, format, quality)
         SELECT ?, 'thumb300', ?, 'webp', 82
         WHERE NOT EXISTS (
           SELECT 1 FROM post_variants WHERE post_id = ? AND kind = 'thumb300'
         )`,
      )
      .run(payload.postId, thumb.url, payload.postId);
  }

  const sources = ctx.sqlite
    .prepare(`SELECT COUNT(*) AS count FROM post_sources WHERE post_id = ? AND status = 'ok'`)
    .get(payload.postId) as { count: number };

  if (sources.count >= ctx.config.minMirrors) {
    ctx.sqlite
      .prepare(
        `UPDATE posts SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(now, payload.postId);
    await cleanupStagingIfDone(ctx, payload);
  }
}

async function unlinkWithRetry(log: Logger, path: string, attempts = 4): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.unlink(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      // Windows can briefly lock freshly written files (libvips, antivirus).
      if (attempt === attempts) {
        log.warn('cannot remove staging file', { path, code: code ?? String(error) });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

async function cleanupStagingIfDone(
  ctx: EngineContext,
  payload: MirrorUploadPayload,
): Promise<void> {
  // The current job row is still locked, so exclude it when counting what is left.
  const remaining = ctx.sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE json_extract(payload, '$.postId') = ? AND id <> ?`,
    )
    .get(payload.postId, payload.jobId ?? -1) as { count: number };
  if (remaining.count > 0) return;

  const log = ctx.log.child({ module: 'jobs' });
  for (const path of [payload.deliveryPath, payload.thumbPath]) {
    if (path) await unlinkWithRetry(log, path);
  }
}

export async function processJobs(ctx: EngineContext, max = 20): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const job = claimJob(ctx.sqlite, 'mirror_upload');
    if (!job) break;
    processed += 1;

    try {
      const payload = JSON.parse(job.payload) as MirrorUploadPayload;
      await handleMirrorUpload(ctx, { ...payload, jobId: job.id });
      ctx.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    } catch (error) {
      retryLater(ctx, job, error instanceof Error ? error.message : String(error));
    }
  }
  return processed;
}

function sourceRunCancelled(ctx: EngineContext, runId: number): boolean {
  const row = ctx.sqlite
    .prepare('SELECT cancel_requested AS cancelRequested FROM source_runs WHERE id = ?')
    .get(runId) as { cancelRequested: number } | undefined;
  return !row || row.cancelRequested === 1;
}

function writeSourceLog(
  ctx: EngineContext,
  runId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  ctx.sqlite
    .prepare('INSERT INTO source_run_logs (run_id, level, message, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, level, message.slice(0, 2000), new Date().toISOString());
}

function saveSourceProgress(ctx: EngineContext, runId: number, stats: ImportStats): void {
  ctx.sqlite
    .prepare(
      `UPDATE source_runs
       SET imported = ?, duplicates = ?, failed = ?, seen = ?, pages = ?,
           newest_origin_id = ?, next_cursor = ?
       WHERE id = ?`,
    )
    .run(
      stats.imported,
      stats.duplicates,
      stats.failed,
      stats.seen,
      stats.pages,
      stats.newestOriginId ?? null,
      stats.nextCursor ?? null,
      runId,
    );
}

async function handleSourceImport(
  ctx: EngineContext,
  payload: SourceImportPayload,
  jobId?: number,
): Promise<void> {
  const run = ctx.sqlite
    .prepare(
      `SELECT id, source, tags, limit_count, page, page_size, delay_ms, status, cancel_requested,
              auto, mode, since_id, cursor
       FROM source_runs WHERE id = ?`,
    )
    .get(payload.runId) as SourceRunRow | undefined;
  if (!run) return;
  // A queued run may have been cancelled before the worker picked it up.
  if (run.status !== 'queued' && run.status !== 'running') return;

  const startedAt = new Date().toISOString();
  ctx.sqlite
    .prepare(
      `UPDATE source_runs
       SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL
       WHERE id = ?`,
    )
    .run(startedAt, run.id);
  writeSourceLog(
    ctx,
    run.id,
    'info',
    `Started ${run.source} import (${run.mode}, limit ${run.limit_count}, page ${run.page}, page size ${run.page_size}).`,
  );

  // Fetch retries otherwise ignore the cancel flag until the current request ends.
  const controller = new AbortController();
  const cancelPoll = setInterval(() => {
    if (sourceRunCancelled(ctx, run.id)) controller.abort();
  }, 500);
  cancelPoll.unref();
  // Imports can outlive the generic five-minute stale-lock window; keep the job
  // claimed while the crawl is still making progress.
  const heartbeat = jobId
    ? setInterval(() => {
        ctx.sqlite
          .prepare('UPDATE jobs SET locked_at = ? WHERE id = ?')
          .run(new Date().toISOString(), jobId);
      }, 30_000)
    : undefined;
  heartbeat?.unref();

  try {
    const source =
      ctx.sourceFactory?.(run.source) ??
      createSource(run.source, sourceOptions(ctx.config, ctx.sqlite));
    const stats = await importFromSource(ctx, source, {
      limit: run.limit_count,
      page: run.page,
      pageSize: run.page_size,
      ...(run.tags ? { tags: run.tags } : {}),
      ...(run.cursor ? { cursor: run.cursor } : {}),
      ...(run.since_id ? { since: run.since_id } : {}),
      delayMs: run.delay_ms,
      signal: controller.signal,
      shouldCancel: () => sourceRunCancelled(ctx, run.id),
      onProgress: (progress) => saveSourceProgress(ctx, run.id, progress),
      onLog: (level, message) => writeSourceLog(ctx, run.id, level, message),
    });

    const cancelled = stats.cancelled || sourceRunCancelled(ctx, run.id);
    saveSourceProgress(ctx, run.id, stats);
    const finishedAt = new Date().toISOString();
    if (cancelled) {
      ctx.sqlite
        .prepare(
          `UPDATE source_runs
           SET status = 'cancelled', cancel_requested = 1, finished_at = ?
           WHERE id = ?`,
        )
        .run(finishedAt, run.id);
      writeSourceLog(
        ctx,
        run.id,
        'warn',
        `Cancelled after ${stats.seen} posts (imported ${stats.imported}, duplicates ${stats.duplicates}, failed ${stats.failed}).`,
      );
    } else {
      ctx.sqlite
        .prepare("UPDATE source_runs SET status = 'completed', finished_at = ? WHERE id = ?")
        .run(finishedAt, run.id);
      writeSourceLog(
        ctx,
        run.id,
        'info',
        `Finished: imported ${stats.imported}, duplicates ${stats.duplicates}, failed ${stats.failed}, seen ${stats.seen}, pages ${stats.pages}.`,
      );
    }
  } catch (error) {
    const cancelled = sourceRunCancelled(ctx, run.id);
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    if (cancelled) {
      ctx.sqlite
        .prepare(
          `UPDATE source_runs
           SET status = 'cancelled', cancel_requested = 1, finished_at = ?
           WHERE id = ?`,
        )
        .run(finishedAt, run.id);
      writeSourceLog(ctx, run.id, 'warn', 'Cancelled by a moderator.');
    } else {
      ctx.sqlite
        .prepare(
          "UPDATE source_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
        )
        .run(message.slice(0, 2000), finishedAt, run.id);
      writeSourceLog(ctx, run.id, 'error', `Failed: ${message}`);
    }
  } finally {
    clearInterval(cancelPoll);
    if (heartbeat) clearInterval(heartbeat);
    // Auto runs advance the source watermarks; manual runs are ignored here.
    try {
      applySourceRunResult(ctx, run.id);
    } catch (error) {
      ctx.log.error('cannot apply source run result', { err: error, runId: run.id });
    }
  }
}

/**
 * Source imports are long-running and live in their own queue so a Danbooru
 * crawl never blocks mirror uploads or other short jobs.
 */
export async function processSourceJobs(ctx: EngineContext, max = 1): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const job = claimJob(ctx.sqlite, 'source_import');
    if (!job) break;
    processed += 1;

    let payload: SourceImportPayload | undefined;
    try {
      payload = JSON.parse(job.payload) as SourceImportPayload;
      await handleSourceImport(ctx, payload, job.id);
      ctx.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (payload?.runId) {
        ctx.sqlite
          .prepare(
            "UPDATE source_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
          )
          .run(message.slice(0, 2000), new Date().toISOString(), payload.runId);
        writeSourceLog(ctx, payload.runId, 'error', `Worker failed: ${message}`);
        try {
          applySourceRunResult(ctx, payload.runId);
        } catch (scheduleError) {
          ctx.log.error('cannot apply source run result', {
            err: scheduleError,
            runId: payload.runId,
          });
        }
      }
      retryLater(ctx, job, message);
    }
  }
  return processed;
}

export async function cleanupStaging(dir: string, ttlMinutes: number): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - ttlMinutes * 60 * 1000;
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const info = await fs.stat(path);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await fs.unlink(path);
        removed += 1;
      }
    } catch {
      // A file may disappear between readdir and stat; ignore.
    }
  }
  return removed;
}
