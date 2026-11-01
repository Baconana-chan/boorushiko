import { describe, expect, it } from 'vitest';
import { processSourceJobs } from '../src/jobs.js';
import {
  ensureSourceSchedules,
  listSourceSchedules,
  tickSourceSchedules,
} from '../src/schedules.js';
import type { BooruSource, SourcePost } from '../src/sources/types.js';
import { createTestContext } from './helpers.js';

function sourcePost(originId: string): SourcePost {
  return {
    provider: 'danbooru',
    originId,
    pageUrl: `https://danbooru.donmai.us/posts/${originId}`,
    fileUrl: `https://cdn.example/${originId}.png`,
    mime: 'image/png',
    rating: 's',
    tags: ['solo'],
  };
}

function due(ctx: ReturnType<typeof createTestContext>['ctx'], source = 'danbooru') {
  // `sourceAutoEnabled` enables every registered source; these tests walk one.
  const past = new Date(Date.now() - 60_000).toISOString();
  ctx.sqlite.prepare('UPDATE source_schedules SET enabled = 0, next_run_at = ?').run(past);
  ctx.sqlite
    .prepare('UPDATE source_schedules SET enabled = 1, next_run_at = ? WHERE source = ?')
    .run(past, source);
}

function runQueuedJobsNow(ctx: ReturnType<typeof createTestContext>['ctx']): void {
  ctx.sqlite
    .prepare("UPDATE jobs SET run_at = ? WHERE kind = 'source_import'")
    .run(new Date(Date.now() - 1000).toISOString());
}

function autoRuns(ctx: ReturnType<typeof createTestContext>['ctx']) {
  return ctx.sqlite
    .prepare(
      `SELECT id, auto, mode, since_id AS sinceId, cursor, status, imported, seen
       FROM source_runs ORDER BY id ASC`,
    )
    .all() as Array<{
    id: number;
    auto: number;
    mode: string;
    sinceId: string | null;
    cursor: string | null;
    status: string;
    imported: number;
    seen: number;
  }>;
}

describe('source scheduler', () => {
  it('alternates head polling and archive backfill without overlapping runs', async () => {
    const { ctx } = createTestContext({
      sourceAutoEnabled: true,
      sourceAutoIntervalMinutes: 30,
      sourceAutoBatch: 2,
      sourceAutoDailyLimit: 100,
    });
    const calls: Array<{ since?: string; cursor?: string }> = [];
    ctx.sourceFactory = (): BooruSource => ({
      name: 'danbooru',
      async fetchPage(request) {
        calls.push({
          ...(request.since ? { since: request.since } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        });
        if (request.since) {
          return { posts: [sourcePost('103')], hasMore: false };
        }
        if (request.cursor) {
          return { posts: [sourcePost('99')], hasMore: false, cursor: '99' };
        }
        return { posts: [sourcePost('101'), sourcePost('102')], hasMore: true, cursor: '101' };
      },
    });

    const now = new Date();
    ensureSourceSchedules(ctx, now);
    due(ctx);
    expect(tickSourceSchedules(ctx, now)).toBe(1);
    expect(tickSourceSchedules(ctx, new Date(now.getTime() + 1_000))).toBe(0);

    runQueuedJobsNow(ctx);
    await processSourceJobs(ctx);
    expect(calls).toEqual([{}]);
    expect(autoRuns(ctx)).toMatchObject([
      { auto: 1, mode: 'head', sinceId: null, status: 'completed' },
    ]);
    let schedule = listSourceSchedules(ctx).find((item) => item.source === 'danbooru')!;
    expect(schedule).toMatchObject({
      headId: '102',
      cursor: '101',
      nextMode: 'backfill',
      backfillDone: false,
    });

    expect(tickSourceSchedules(ctx, new Date(now.getTime() + 31 * 60_000))).toBe(1);
    runQueuedJobsNow(ctx);
    await processSourceJobs(ctx);
    expect(calls).toEqual([{}, { cursor: '101' }]);
    schedule = listSourceSchedules(ctx).find((item) => item.source === 'danbooru')!;
    expect(schedule).toMatchObject({
      headId: '102',
      cursor: '99',
      nextMode: 'head',
      backfillDone: false,
    });

    expect(tickSourceSchedules(ctx, new Date(now.getTime() + 62 * 60_000))).toBe(1);
    runQueuedJobsNow(ctx);
    await processSourceJobs(ctx);
    expect(calls).toEqual([{}, { cursor: '101' }, { since: '102' }]);
    schedule = listSourceSchedules(ctx).find((item) => item.source === 'danbooru')!;
    expect(schedule).toMatchObject({ headId: '103', nextMode: 'backfill' });
    expect(autoRuns(ctx).filter((run) => run.status === 'completed')).toHaveLength(3);
  });

  it('defers when another run is active or the daily cap is reached', async () => {
    const { ctx } = createTestContext({
      sourceAutoEnabled: true,
      sourceAutoBatch: 2,
      sourceAutoDailyLimit: 2,
    });
    const now = new Date();
    ensureSourceSchedules(ctx, now);
    due(ctx);

    const active = ctx.sqlite
      .prepare(
        `INSERT INTO source_runs (source, limit_count, page, page_size, delay_ms, status, created_at)
         VALUES ('danbooru', 2, 1, 2, 1100, 'queued', ?)`,
      )
      .run(now.toISOString());
    expect(tickSourceSchedules(ctx, now)).toBe(0);
    ctx.sqlite.prepare('DELETE FROM source_runs WHERE id = ?').run(active.lastInsertRowid);

    ctx.sqlite
      .prepare(
        `INSERT INTO source_runs
          (source, limit_count, page, page_size, delay_ms, status, auto, mode, seen, created_at)
         VALUES ('danbooru', 2, 1, 2, 1100, 'completed', 1, 'head', 2, ?)`,
      )
      .run(now.toISOString());
    expect(tickSourceSchedules(ctx, now)).toBe(0);
    const schedule = listSourceSchedules(ctx, now).find((item) => item.source === 'danbooru')!;
    expect(schedule.lastError).toContain('daily cap');
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it('backs off after a failed auto run', async () => {
    const { ctx } = createTestContext({
      sourceAutoEnabled: true,
      sourceAutoIntervalMinutes: 30,
      sourceAutoBatch: 2,
    });
    ctx.sourceFactory = (): BooruSource => ({
      name: 'danbooru',
      async fetchPage() {
        throw new Error('source is down');
      },
    });

    const now = new Date();
    ensureSourceSchedules(ctx, now);
    due(ctx);
    expect(tickSourceSchedules(ctx, now)).toBe(1);
    runQueuedJobsNow(ctx);
    await processSourceJobs(ctx);

    const schedule = listSourceSchedules(ctx, now).find((item) => item.source === 'danbooru')!;
    expect(schedule.failureCount).toBe(1);
    expect(schedule.lastError).toContain('source is down');
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(now.getTime() + 30 * 60_000);
  });
});
