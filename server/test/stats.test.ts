import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('archive statistics', () => {
  it('aggregates public counts without authentication', async () => {
    const { ctx } = createTestContext();
    const app = buildApp(ctx);
    apps.push(app);

    const animated = seedPost(ctx, {
      md5: 'a'.repeat(32),
      tags: ['alpha'],
      rating: 's',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seedPost(ctx, {
      md5: 'b'.repeat(32),
      tags: ['beta'],
      rating: 'q',
      status: 'pending',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    seedPost(ctx, {
      md5: 'c'.repeat(32),
      tags: ['gamma'],
      rating: 'e',
      status: 'deleted',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    ctx.sqlite
      .prepare("UPDATE posts SET mime = 'image/gif', ext = 'gif' WHERE id = ?")
      .run(animated);

    ctx.sqlite
      .prepare("INSERT INTO tags (name, category, post_count) VALUES ('artist_x', 'artist', 1)")
      .run();

    const userId = Number(
      ctx.sqlite
        .prepare(
          `INSERT INTO users (username, username_lower, password_hash, created_at)
           VALUES ('someone', 'someone', 'hash', '2026-01-01T00:00:00.000Z')`,
        )
        .run().lastInsertRowid,
    );
    ctx.sqlite
      .prepare(
        `INSERT INTO uploaders (user_id, approved_at) VALUES (?, '2026-01-02T00:00:00.000Z')`,
      )
      .run(userId);
    ctx.sqlite
      .prepare(
        `INSERT INTO comments (post_id, user_id, body, created_at, updated_at)
         VALUES (?, ?, 'nice', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`,
      )
      .run(animated, userId);
    ctx.sqlite
      .prepare(
        `INSERT INTO post_sources (post_id, host, url, role, status, created_at)
         VALUES (?, 'catbox', 'https://files.catbox.moe/a.png', 'serve', 'ok',
                 '2026-01-01T00:00:00.000Z')`,
      )
      .run(animated);
    ctx.sqlite
      .prepare(
        `INSERT INTO post_origins (post_id, provider, file_url)
         VALUES (?, 'danbooru', 'https://cdn.example/a.png')`,
      )
      .run(animated);

    const response = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      posts: { total: 3, active: 1, pending: 1, hidden: 0, deleted: 1 },
      media: { images: 2, animated: 1, videos: 0 },
      ratings: { general: 1, sensitive: 1, explicit: 0 },
      tags: { total: 4, general: 3, artist: 1 },
      community: { members: 1, uploaders: 1, comments: 1 },
      sources: { hosted: 2, remote: 0, mirrors: 1, origins: 1, providers: 1 },
      activity: {
        oldest: '2026-01-01T00:00:00.000Z',
        newest: '2026-02-01T00:00:00.000Z',
      },
    });
    expect(response.json().generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Deleted posts must not silently vanish from the status total.
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get()).toEqual({ count: 3 });
  });
});
