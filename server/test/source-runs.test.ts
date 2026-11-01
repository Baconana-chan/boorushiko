import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { BooruSource, SourcePost } from '../src/sources/types.js';
import { createTestContext } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const context = createTestContext({ commentCooldownSeconds: 0, ...overrides });
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : (raw ?? '');
  return value.split(';')[0] ?? '';
}

async function signUp(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'correct-horse' },
  });
  return cookieFrom(response);
}

function makeStaff(
  ctx: ReturnType<typeof createTestContext>['ctx'],
  username: string,
  role: string,
) {
  ctx.sqlite
    .prepare('UPDATE users SET role = ? WHERE username_lower = ?')
    .run(role, username.toLowerCase());
}

const posts: SourcePost[] = [
  {
    provider: 'danbooru',
    originId: '101',
    pageUrl: 'https://danbooru.donmai.us/posts/101',
    fileUrl: 'https://cdn.example/101.png',
    previewUrl: 'https://cdn.example/101-preview.png',
    mime: 'image/png',
    rating: 'q',
    tags: ['solo', 'artist:someone'],
  },
  {
    provider: 'danbooru',
    originId: '102',
    pageUrl: 'https://danbooru.donmai.us/posts/102',
    fileUrl: 'https://cdn.example/102.png',
    previewUrl: 'https://cdn.example/102-preview.png',
    mime: 'image/png',
    rating: 's',
    tags: ['landscape'],
  },
];

function staticSource(items: SourcePost[]): BooruSource {
  return {
    name: 'danbooru',
    async fetchPage() {
      return { posts: items, hasMore: false, cursor: '100' };
    },
  };
}

interface RunDetail {
  run: {
    id: number;
    status: string;
    imported: number;
    duplicates: number;
    failed: number;
    seen: number;
    pages: number;
    cancelRequested: boolean;
    error: string | null;
  };
  logs: Array<{ level: string; message: string }>;
}

async function waitForRun(
  app: FastifyInstance,
  cookie: string,
  id: number,
  statuses: string[],
  timeoutMs = 4000,
): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: RunDetail | null = null;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/source-runs/${id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    last = response.json() as RunDetail;
    if (statuses.includes(last.run.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} did not reach ${statuses.join('/')}; last=${JSON.stringify(last)}`);
}

describe('source runs', () => {
  it('runs an import in the background and exposes progress and logs', async () => {
    const { app, ctx } = makeApp();
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');
    ctx.sourceFactory = () => staticSource(posts);

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      payload: { source: 'danbooru', limit: 2 },
    });
    expect(denied.statusCode).toBe(401);

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      headers: { cookie: moderator },
      payload: { source: 'danbooru', tags: 'solo', limit: 2 },
    });
    expect(started.statusCode).toBe(201);
    const runId = started.json().run.id as number;

    const detail = await waitForRun(app, moderator, runId, ['completed']);
    expect(detail.run).toMatchObject({
      status: 'completed',
      imported: 2,
      duplicates: 0,
      failed: 0,
      seen: 2,
      pages: 1,
      cancelRequested: false,
    });
    expect(detail.logs.some((log) => log.message.includes('Imported danbooru/101'))).toBe(true);
    expect(detail.logs.some((log) => log.message.includes('Finished:'))).toBe(true);

    const postsCount = ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get() as {
      count: number;
    };
    expect(postsCount.count).toBe(2);

    const listing = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sources',
      headers: { cookie: moderator },
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().sources).toEqual(['danbooru', 'gelbooru']);
    expect(listing.json().runs[0]).toMatchObject({ id: runId, status: 'completed' });

    // The second run is allowed and detects duplicates by provider+originId.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      headers: { cookie: moderator },
      payload: { source: 'danbooru', limit: 2 },
    });
    expect(second.statusCode).toBe(201);
    const secondDetail = await waitForRun(app, moderator, second.json().run.id as number, [
      'completed',
    ]);
    expect(secondDetail.run).toMatchObject({ imported: 0, duplicates: 2, seen: 2 });
  });

  it('blocks a second active run and cancels a running import', async () => {
    const { app, ctx } = makeApp();
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');

    ctx.sourceFactory = () => ({
      name: 'danbooru',
      async fetchPage(request) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ posts: [posts[0]!], hasMore: true, cursor: '100' }),
            800,
          );
          request.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      },
    });

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      headers: { cookie: moderator },
      payload: { source: 'danbooru', limit: 10 },
    });
    expect(started.statusCode).toBe(201);
    const runId = started.json().run.id as number;
    await waitForRun(app, moderator, runId, ['running']);

    const busy = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      headers: { cookie: moderator },
      payload: { source: 'danbooru', limit: 10 },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe('source_busy');

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/source-runs/${runId}/cancel`,
      headers: { cookie: moderator },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.cancelRequested).toBe(true);

    const detail = await waitForRun(app, moderator, runId, ['cancelled']);
    expect(detail.run.status).toBe('cancelled');
    expect(detail.logs.some((log) => log.message.includes('Cancellation requested'))).toBe(true);
    expect(detail.logs.some((log) => log.message.includes('Cancelled'))).toBe(true);
  });

  it('cancels a queued run before a worker picks it up', async () => {
    const { app, ctx } = makeApp();
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');

    const now = new Date().toISOString();
    const inserted = ctx.sqlite
      .prepare(
        `INSERT INTO source_runs
          (source, tags, limit_count, page, page_size, delay_ms, status, created_at)
         VALUES ('danbooru', 'solo', 10, 1, 50, 1100, 'queued', ?)`,
      )
      .run(now);
    const runId = Number(inserted.lastInsertRowid);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/source-runs/${runId}/cancel`,
      headers: { cookie: moderator },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      finishedAt: expect.any(String),
    });
  });

  it('exposes and updates the automatic schedule', async () => {
    const { app, ctx } = makeApp();
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');

    const listing = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sources',
      headers: { cookie: moderator },
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().schedules).toMatchObject([
      { source: 'danbooru', enabled: false, intervalMinutes: 30, batchLimit: 20 },
      { source: 'gelbooru', enabled: false, intervalMinutes: 30, batchLimit: 20 },
    ]);

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/source-schedules/danbooru',
      headers: { cookie: moderator },
      payload: {
        enabled: true,
        intervalMinutes: 15,
        batchLimit: 5,
        dailyLimit: 50,
        tags: 'rating:g',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().schedule).toMatchObject({
      source: 'danbooru',
      enabled: true,
      intervalMinutes: 15,
      batchLimit: 5,
      dailyLimit: 50,
      tags: 'rating:g',
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/source-schedules/danbooru',
      headers: { cookie: moderator },
      payload: { intervalMinutes: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('invalid_schedule');
  });

  it('validates the source and the run limits', async () => {
    const { app, ctx } = makeApp();
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      headers: { cookie: moderator },
      payload: { source: 'pixiv', limit: 10 },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('unknown_source');

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/source-runs',
      headers: { cookie: moderator },
      payload: { source: 'danbooru', limit: 501 },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().code).toBe('invalid_limits');
  });
});
