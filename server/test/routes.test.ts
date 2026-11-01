import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const context = createTestContext(overrides);
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

describe('HTTP routes', () => {
  it('applies safe, mixed and adult rating modes', async () => {
    const { ctx, app } = makeApp();
    seedPost(ctx, { md5: '1'.repeat(32), tags: ['flandre'], rating: 's' });
    seedPost(ctx, { md5: '2'.repeat(32), tags: ['flandre'], rating: 'q' });
    seedPost(ctx, { md5: '3'.repeat(32), tags: ['flandre'], rating: 'e' });

    const safe = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre&rating_mode=safe',
    });
    expect(safe.statusCode).toBe(200);
    expect(safe.json().posts).toHaveLength(1);
    expect(safe.json().posts[0].rating).toBe('s');

    const mixed = await app.inject({ method: 'GET', url: '/api/v1/posts?tags=flandre' });
    expect(
      mixed
        .json()
        .posts.map((post: { rating: string }) => post.rating)
        .sort(),
    ).toEqual(['q', 's']);

    const adult = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre&rating_mode=adult',
    });
    expect(adult.json().posts).toHaveLength(1);
    expect(adult.json().posts[0].rating).toBe('e');

    // The old binary flag means "all ratings" for parser and API clients.
    const legacy = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre&show_explicit=1',
    });
    expect(legacy.json().posts).toHaveLength(3);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?rating_mode=anything',
    });
    expect(invalid.statusCode).toBe(400);

    // A search filter cannot lift the visibility ceiling...
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre%20rating:e&rating_mode=mixed',
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().posts).toHaveLength(0);

    // ...and Adult is explicit-only, so asking for safe inside it stays empty.
    const adultSafe = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre%20rating:s&rating_mode=adult',
    });
    expect(adultSafe.json().posts).toHaveLength(0);
  });

  it('accepts multi-word and wildcard tag queries over HTTP', async () => {
    const { ctx, app } = makeApp();
    seedPost(ctx, { md5: '6'.repeat(32), tags: ['pixel_art', 'sign'] });
    seedPost(ctx, { md5: '7'.repeat(32), tags: ['pixel'] });

    const phrase = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=pixel%20art',
    });
    expect(phrase.statusCode).toBe(200);
    expect(phrase.json().posts).toHaveLength(1);

    const threeWords = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=pixel%20art%20sign',
    });
    expect(threeWords.json().posts).toHaveLength(1);

    const comma = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=pixel%20art%2C%20sign',
    });
    expect(comma.json().posts).toHaveLength(1);

    const wildcard = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=%25pixel%25',
    });
    expect(wildcard.json().posts).toHaveLength(2);

    const suggestions = await app.inject({
      method: 'GET',
      url: '/api/v1/tags?search=pixel%20art',
    });
    expect(suggestions.json().tags[0].name).toBe('pixel_art');
  });

  it('returns 400 for a broken search query', async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/posts?tags=rating:zzz' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/unknown rating/);
  });

  it('serves post details, tags and the media redirects', async () => {
    const { ctx, app } = makeApp();
    const postId = seedPost(ctx, { md5: '4'.repeat(32), tags: ['remilia', 'solo'] });
    const now = new Date().toISOString();
    ctx.sqlite
      .prepare(
        `INSERT INTO post_sources (post_id, host, url, role, status, created_at)
         VALUES (?, 'fake', 'https://fake.local/post.png', 'serve', 'ok', ?)`,
      )
      .run(postId, now);
    ctx.sqlite
      .prepare(
        `INSERT INTO post_variants (post_id, kind, url, format)
         VALUES (?, 'thumb300', 'https://fake.local/thumb.webp', 'webp')`,
      )
      .run(postId);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    expect(detail.statusCode).toBe(200);
    expect(
      detail
        .json()
        .tags.map((tag: { name: string }) => tag.name)
        .sort(),
    ).toEqual(['remilia', 'solo']);
    expect(detail.json().sources).toHaveLength(1);
    expect(detail.json().thumbUrl).toBe(`/t/${postId}?v=2`);

    const full = await app.inject({ method: 'GET', url: `/i/${postId}` });
    expect(full.statusCode).toBe(302);
    expect(full.headers.location).toBe('https://fake.local/post.png');

    const thumb = await app.inject({ method: 'GET', url: `/t/${postId}` });
    expect(thumb.statusCode).toBe(302);
    expect(thumb.headers.location).toBe('https://fake.local/thumb.webp');

    const tags = await app.inject({ method: 'GET', url: '/api/v1/tags?search=rem' });
    expect(tags.json().tags[0].name).toBe('remilia');
  });

  it('creates a remote post through the parser endpoint and proxies its thumbnail', async () => {
    const { ctx, app } = makeApp({ uploadToken: 'secret' });
    const payload = {
      provider: 'danbooru',
      originId: '987',
      pageUrl: 'https://danbooru.donmai.us/posts/987',
      fileUrl: 'https://cdn.example/art.png',
      sourceUrl: 'https://www.pixiv.net/artworks/146828566',
      previewUrl: 'https://cdn.example/art-preview.png',
      mime: 'image/png',
      rating: 'q',
      width: 1200,
      height: 900,
      bytes: 1500000,
      tags: 'flandre, solo',
    };

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/posts/remote',
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/posts/remote',
      headers: { 'x-upload-token': 'secret' },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const postId = created.json().postId as number;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    expect(detail.json().sourceUrl).toBe('https://www.pixiv.net/artworks/146828566');

    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/posts/remote',
      headers: { 'x-upload-token': 'secret' },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ postId, duplicate: true });

    const full = await app.inject({ method: 'GET', url: `/i/${postId}` });
    expect(full.statusCode).toBe(302);
    expect(full.headers.location).toBe('https://cdn.example/art.png');

    // Mark the origin dead so the thumbnail route does not touch the network in tests.
    ctx.sqlite
      .prepare("UPDATE post_origins SET status = 'source_dead' WHERE post_id = ?")
      .run(postId);
    const thumb = await app.inject({ method: 'GET', url: `/t/${postId}` });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/svg+xml');
    expect(thumb.headers['cache-control']).toContain('max-age=60');

    const cached = await app.inject({
      method: 'GET',
      url: `/t/${postId}`,
      headers: { 'if-none-match': String(thumb.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('requires the upload token when configured', async () => {
    const { app } = makeApp({ uploadToken: 'secret' });
    const response = await app.inject({ method: 'POST', url: '/api/v1/posts' });
    expect(response.statusCode).toBe(401);
  });

  it('keeps bot endpoints closed when no token is configured', async () => {
    const { app } = makeApp();
    const upload = await app.inject({ method: 'POST', url: '/api/v1/posts' });
    expect(upload.statusCode).toBe(401);

    const remote = await app.inject({ method: 'POST', url: '/api/v1/posts/remote', payload: {} });
    expect(remote.statusCode).toBe(401);
  });

  it('reports health', async () => {
    const { ctx, app } = makeApp();
    seedPost(ctx, { md5: '5'.repeat(32) });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.json()).toMatchObject({ ok: true, posts: 1 });
  });

  it('hides sensitive posts from listings and detail unless include_sensitive=1', async () => {
    const { ctx, app } = makeApp();
    const normalId = seedPost(ctx, { md5: 'a'.repeat(32), tags: ['flandre', 'solo'] });
    const sensitiveId = seedPost(ctx, { md5: 'b'.repeat(32), tags: ['flandre', 'shota'] });

    const hidden = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre&include_sensitive=0',
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().posts.map((post: { id: number }) => post.id)).toEqual([normalId]);

    const shown = await app.inject({ method: 'GET', url: '/api/v1/posts?tags=flandre' });
    expect(
      shown
        .json()
        .posts.map((post: { id: number }) => post.id)
        .sort(),
    ).toEqual([normalId, sensitiveId].sort());

    const detailHidden = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${sensitiveId}?include_sensitive=0`,
    });
    expect(detailHidden.statusCode).toBe(403);
    expect(detailHidden.json().code).toBe('sensitive_hidden');

    const detailShown = await app.inject({ method: 'GET', url: `/api/v1/posts/${sensitiveId}` });
    expect(detailShown.statusCode).toBe(200);
  });

  it('serves robots.txt and a sitemap for active posts only', async () => {
    const { ctx, app } = makeApp({ publicBaseUrl: 'https://booru.example' });
    const activeId = seedPost(ctx, { md5: '8'.repeat(32) });
    const pendingId = seedPost(ctx, { md5: '9'.repeat(32), status: 'pending' });

    const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers['content-type']).toContain('text/plain');
    expect(robots.body).toContain('Sitemap: https://booru.example/sitemap.xml');
    expect(robots.body).toContain('Disallow: /admin');

    const index = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('application/xml');
    expect(index.body).toContain('<sitemapindex');
    expect(index.body).toContain('https://booru.example/sitemap-posts-1.xml');

    const posts = await app.inject({ method: 'GET', url: '/sitemap-posts-1.xml' });
    expect(posts.statusCode).toBe(200);
    expect(posts.body).toContain(`https://booru.example/post/${activeId}`);
    expect(posts.body).not.toContain(`https://booru.example/post/${pendingId}`);

    const pages = await app.inject({ method: 'GET', url: '/sitemap-pages.xml' });
    expect(pages.body).toContain('https://booru.example/stats');

    const missing = await app.inject({ method: 'GET', url: '/sitemap-posts-2.xml' });
    expect(missing.statusCode).toBe(404);
  });

  it('serves RFC 9116 security.txt from configuration', async () => {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { app } = makeApp({
      publicBaseUrl: 'https://booru.example',
      securityContact: 'mailto:security@booru.example',
      securityExpires: expires,
    });

    const response = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('Contact: mailto:security@booru.example');
    expect(response.body).toContain(`Expires: ${expires}`);
    expect(response.body).toContain('Canonical: https://booru.example/.well-known/security.txt');
    expect(response.body).toContain('Policy: https://booru.example/rules');
    expect(response.body).toContain('Preferred-Languages: en, ru');
  });
});
