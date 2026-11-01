import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { healthSnapshot, readySnapshot } from '../src/health.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('health and readiness', () => {
  it('reports database, disk, queue and mirror state', async () => {
    const { ctx } = createTestContext();
    const postId = seedPost(ctx, { md5: 'a'.repeat(32) });
    const now = new Date().toISOString();
    const insertSource = ctx.sqlite.prepare(
      `INSERT INTO post_sources (post_id, host, url, role, status, created_at)
       VALUES (?, ?, ?, 'serve', ?, ?)`,
    );
    insertSource.run(postId, 'fake', 'https://fake.local/ok.png', 'ok', now);
    insertSource.run(postId, 'fake', 'https://fake.local/dead.png', 'dead', now);

    const health = await healthSnapshot(ctx);
    expect(health).toMatchObject({ ok: true, posts: 1, queue: { pending: 0 } });
    expect(health.mirrors.find((mirror) => mirror.host === 'fake')).toMatchObject({
      total: 2,
      ok: 1,
      dead: 1,
    });
    expect(health.disk.freeBytes).toBeGreaterThan(0);
    expect(health.maintenance).toEqual([]);
  });

  it('turns unhealthy when the database stops answering', async () => {
    const { ctx } = createTestContext();
    ctx.sqlite.close();

    const health = await healthSnapshot(ctx);
    expect(health.ok).toBe(false);
    expect(health.db.ok).toBe(false);
    expect(health.db.error).toBeTruthy();
  });

  it('checks that the staging directory is writable', async () => {
    const { ctx } = createTestContext();
    const ready = await readySnapshot(ctx);
    expect(ready).toMatchObject({ ok: true, db: { ok: true }, staging: { ok: true } });
  });

  it('serves /readyz and tags health responses with a request id', async () => {
    const { ctx } = createTestContext();
    const app = buildApp(ctx);
    apps.push(app);

    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().ok).toBe(true);

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-request-id']).toBeTruthy();

    const echoed = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'deploy-check-12345' },
    });
    expect(echoed.headers['x-request-id']).toBe('deploy-check-12345');
  });
});
