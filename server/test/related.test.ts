import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { findRelatedPosts } from '../src/related.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const categories = {
  flandre: 'character',
  touhou: 'copyright',
  art_x: 'artist',
  highres: 'meta',
  commentary_request: 'meta',
};

describe('findRelatedPosts', () => {
  it('ranks a shared artist tag above a shared generic one', () => {
    const { ctx } = createTestContext();
    // Fillers inflate `smile`, so its idf weight drops below a rare tag's.
    for (let index = 0; index < 8; index += 1) {
      seedPost(ctx, { md5: `f${index}`.padEnd(32, '0'), tags: ['smile'] });
    }

    const seed = seedPost(ctx, {
      md5: 'a'.repeat(32),
      tags: ['flandre', 'touhou', 'smile', 'art_x'],
      categories,
    });
    const sameArtist = seedPost(ctx, { md5: 'b'.repeat(32), tags: ['art_x'] });
    const sameCopyright = seedPost(ctx, { md5: 'c'.repeat(32), tags: ['touhou'] });
    const sameGeneric = seedPost(ctx, { md5: 'd'.repeat(32), tags: ['smile'] });

    const result = findRelatedPosts(ctx.sqlite, seed, { limit: 10, ratings: ['s', 'q', 'e'] });
    const ids = result.posts.map((post) => post.id);

    expect(ids).not.toContain(seed);
    expect(ids[0]).toBe(sameArtist);
    expect(ids.indexOf(sameCopyright)).toBeLessThan(ids.indexOf(sameGeneric));

    for (const post of result.posts) {
      expect(post.similarity).toBeGreaterThan(0);
      expect(post.similarity).toBeLessThanOrEqual(1);
      expect(post.tags.length).toBeGreaterThan(0);
    }
    expect(result.posts[0]?.sharedTags).toContain('art_x');
  });

  it('ignores meta tags when they are the only overlap', () => {
    const { ctx } = createTestContext();
    const seed = seedPost(ctx, { md5: 'e'.repeat(32), tags: ['flandre', 'highres'], categories });
    const metaOnly = seedPost(ctx, {
      md5: 'f'.repeat(32),
      tags: ['highres', 'commentary_request'],
    });
    const related = seedPost(ctx, { md5: '0'.repeat(32), tags: ['flandre'], categories });

    const result = findRelatedPosts(ctx.sqlite, seed, { limit: 10, ratings: ['s', 'q', 'e'] });
    const ids = result.posts.map((post) => post.id);

    expect(ids).toContain(related);
    expect(ids).not.toContain(metaOnly);
    expect(result.seedTags).toEqual(['flandre']);
  });

  it('respects the rating ceiling, sensitive tags and explicit exclusions', () => {
    const { ctx } = createTestContext();
    const seed = seedPost(ctx, { md5: '1'.repeat(32), tags: ['flandre'], categories });
    const safeMatch = seedPost(ctx, { md5: '2'.repeat(32), tags: ['flandre'], categories });
    const explicitMatch = seedPost(ctx, {
      md5: '3'.repeat(32),
      tags: ['flandre'],
      categories,
      rating: 'e',
    });
    const sensitiveMatch = seedPost(ctx, {
      md5: '4'.repeat(32),
      tags: ['flandre', 'loli'],
      categories,
    });
    const hiddenMatch = seedPost(ctx, { md5: '5'.repeat(32), tags: ['flandre'], categories });

    const mixed = findRelatedPosts(ctx.sqlite, seed, {
      limit: 10,
      ratings: ['s', 'q'],
      includeSensitive: false,
      sensitiveTags: ['loli*'],
    });
    const ids = mixed.posts.map((post) => post.id);
    expect(ids).toContain(safeMatch);
    expect(ids).not.toContain(explicitMatch);
    expect(ids).not.toContain(sensitiveMatch);

    const filtered = findRelatedPosts(ctx.sqlite, seed, {
      limit: 10,
      ratings: ['s', 'q', 'e'],
      excludeIds: [hiddenMatch],
    });
    expect(filtered.posts.map((post) => post.id)).not.toContain(hiddenMatch);
  });

  it('returns nothing when a post has only structural tags', () => {
    const { ctx } = createTestContext();
    const seed = seedPost(ctx, {
      md5: '6'.repeat(32),
      tags: ['highres', 'commentary_request'],
      categories,
    });
    seedPost(ctx, { md5: '7'.repeat(32), tags: ['highres'], categories });

    const result = findRelatedPosts(ctx.sqlite, seed, { limit: 10 });
    expect(result.posts).toEqual([]);
    expect(result.seedTags).toEqual([]);
  });

  it('serves related posts over HTTP with absolute links', async () => {
    const { ctx } = createTestContext();
    const seed = seedPost(ctx, { md5: 'a1'.repeat(16), tags: ['flandre'], categories });
    const match = seedPost(ctx, { md5: 'a2'.repeat(16), tags: ['flandre'], categories });
    const explicit = seedPost(ctx, {
      md5: 'a3'.repeat(16),
      tags: ['flandre'],
      categories,
      rating: 'e',
    });
    const app = buildApp(ctx);
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${seed}/related?limit=5`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.postId).toBe(seed);
    expect(body.seedTags).toEqual(['flandre']);
    expect(body.posts.map((post: { id: number }) => post.id)).toEqual([match]);
    expect(body.posts[0].absoluteUrl).toMatch(/\/i\/\d+$/);
    expect(body.posts[0].sharedTags).toEqual(['flandre']);

    const adult = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${seed}/related?rating_mode=adult`,
    });
    expect(adult.json().posts.map((post: { id: number }) => post.id)).toEqual([explicit]);

    const broken = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${seed}/related?rating_mode=whatever`,
    });
    expect(broken.statusCode).toBe(400);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/posts/999999/related' });
    expect(missing.statusCode).toBe(404);
  });

  it('still finds a match when every seed tag is very common', () => {
    const { ctx } = createTestContext();
    // A zero scan budget forces the "keep the cheapest tag" fallback.
    const seed = seedPost(ctx, { md5: '8'.repeat(32), tags: ['1girl'] });
    const match = seedPost(ctx, { md5: '9'.repeat(32), tags: ['1girl'] });

    const result = findRelatedPosts(ctx.sqlite, seed, {
      limit: 5,
      ratings: ['s', 'q', 'e'],
      scanBudget: 0,
    });
    expect(result.posts.map((post) => post.id)).toEqual([match]);
  });
});
