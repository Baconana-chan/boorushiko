import type { EngineContext } from '../context.js';
import { createRemotePost, type CreateRemotePostResult } from '../remote.js';
import type { BooruSource, SourcePost } from './types.js';

export interface ImportOptions {
  limit: number;
  page?: number;
  pageSize?: number;
  tags?: string;
  /** Start below this id (archive backfill). */
  cursor?: string;
  /** Poll only posts newer than this id (incremental head). */
  since?: string;
  /** Delay between API pages. Danbooru asks clients to stay around 1 request/sec. */
  delayMs?: number;
  signal?: AbortSignal;
  onPost?: (post: SourcePost, result: CreateRemotePostResult) => void;
  onProgress?: (stats: ImportStats) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Checked between posts and pages; lets the admin UI cancel a run. */
  shouldCancel?: () => boolean;
}

export interface ImportFailure {
  originId: string;
  message: string;
}

export interface ImportStats {
  imported: number;
  duplicates: number;
  failed: number;
  seen: number;
  pages: number;
  cancelled: boolean;
  failures: ImportFailure[];
  /** Newest/oldest post id seen in this run, for incremental watermarks. */
  newestOriginId?: string;
  oldestOriginId?: string;
  /** Cursor for the next backwards page, when the adapter provides one. */
  nextCursor?: string;
  /** Whether the source reported another page after the last request. */
  hasMore?: boolean;
}

function numericOriginId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function trackOrigin(stats: ImportStats, originId: string): void {
  const id = numericOriginId(originId);
  if (id === null) return;
  const newest = stats.newestOriginId ? numericOriginId(stats.newestOriginId) : null;
  const oldest = stats.oldestOriginId ? numericOriginId(stats.oldestOriginId) : null;
  if (newest === null || id > newest) stats.newestOriginId = originId;
  if (oldest === null || id < oldest) stats.oldestOriginId = originId;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function importFromSource(
  ctx: EngineContext,
  source: BooruSource,
  options: ImportOptions,
): Promise<ImportStats> {
  const limit = Math.max(1, Math.floor(options.limit));
  const pageSize = Math.min(Math.max(1, Math.floor(options.pageSize ?? 50)), 200);
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 1100));
  const stats: ImportStats = {
    imported: 0,
    duplicates: 0,
    failed: 0,
    seen: 0,
    pages: 0,
    cancelled: false,
    failures: [],
  };
  const isCancelled = () => options.signal?.aborted === true || options.shouldCancel?.() === true;

  let page = Math.max(1, Math.floor(options.page ?? 1));
  let cursor = options.cursor;
  const since = options.since;
  while (stats.seen < limit) {
    if (isCancelled()) {
      stats.cancelled = true;
      options.onLog?.('warn', 'Run cancelled before the next page.');
      break;
    }
    const remaining = limit - stats.seen;
    const result = await source.fetchPage({
      page,
      limit: Math.min(pageSize, remaining),
      tags: options.tags,
      cursor,
      ...(since ? { since } : {}),
      signal: options.signal,
    });
    stats.pages += 1;
    if (result.cursor) stats.nextCursor = result.cursor;
    stats.hasMore = result.hasMore;
    cursor = result.cursor;

    for (const post of result.posts) {
      if (stats.seen >= limit) break;
      if (isCancelled()) {
        stats.cancelled = true;
        options.onLog?.('warn', `Run cancelled after ${stats.seen} posts.`);
        break;
      }
      stats.seen += 1;
      trackOrigin(stats, post.originId);
      try {
        const created = createRemotePost(ctx, post);
        if (created.duplicate) {
          stats.duplicates += 1;
          options.onLog?.(
            'info',
            `Duplicate ${post.provider}/${post.originId} (post #${created.postId}).`,
          );
        } else {
          stats.imported += 1;
          options.onLog?.(
            'info',
            `Imported ${post.provider}/${post.originId} as post #${created.postId}.`,
          );
        }
        options.onPost?.(post, created);
      } catch (error) {
        stats.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        stats.failures.push({ originId: post.originId, message });
        options.onLog?.('warn', `Failed ${post.provider}/${post.originId}: ${message}`);
      }
      options.onProgress?.({ ...stats, failures: stats.failures });
    }

    options.onProgress?.({ ...stats, failures: stats.failures });
    options.onLog?.(
      'info',
      `Page ${stats.pages}: seen ${stats.seen}/${limit}, imported ${stats.imported}, duplicates ${stats.duplicates}, failed ${stats.failed}.`,
    );

    if (stats.cancelled || !result.hasMore || stats.seen >= limit) break;
    // Cursor-based sources ignore page numbers; offset-based ones need the next page.
    if (!result.cursor) page += 1;
    if (delayMs > 0) await sleep(delayMs, options.signal);
  }

  return stats;
}
