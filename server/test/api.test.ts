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

describe('public API', () => {
  it('walks forward and backward with keyset cursors', async () => {
    const { ctx, app } = makeApp();
    const first = seedPost(ctx, { md5: 'a'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z' });
    const second = seedPost(ctx, { md5: 'b'.repeat(32), createdAt: '2026-01-02T00:00:00.000Z' });
    const third = seedPost(ctx, { md5: 'c'.repeat(32), createdAt: '2026-01-03T00:00:00.000Z' });

    const page1 = await app.inject({ method: 'GET', url: '/api/v1/posts?limit=2&after_id=0' });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().posts.map((post: { id: number }) => post.id)).toEqual([first, second]);
    expect(page1.json().hasMore).toBe(true);
    expect(page1.json().nextCursor).toBe(second);

    // New uploads between the two calls cannot shift this page: it continues by id.
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/posts?limit=2&after_id=${page1.json().nextCursor}`,
    });
    expect(page2.json().posts.map((post: { id: number }) => post.id)).toEqual([third]);
    expect(page2.json().hasMore).toBe(false);
    expect(page2.json().nextCursor).toBe(third);

    const backwards = await app.inject({
      method: 'GET',
      url: `/api/v1/posts?limit=2&before_id=${third}`,
    });
    expect(backwards.json().posts.map((post: { id: number }) => post.id)).toEqual([second, first]);
    expect(backwards.json().hasMore).toBe(false);

    const malformed = await app.inject({ method: 'GET', url: '/api/v1/posts?after_id=abc' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('invalid_cursor');

    const both = await app.inject({ method: 'GET', url: '/api/v1/posts?after_id=1&before_id=5' });
    expect(both.statusCode).toBe(400);
  });

  it('keeps the cursor compatible with tag filters', async () => {
    const { ctx, app } = makeApp();
    const a = seedPost(ctx, { md5: '1'.repeat(32), tags: ['flandre'] });
    seedPost(ctx, { md5: '2'.repeat(32), tags: ['marisa'] });
    const c = seedPost(ctx, { md5: '3'.repeat(32), tags: ['flandre'] });

    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/posts?tags=flandre&after_id=0',
    });
    expect(result.json().posts.map((post: { id: number }) => post.id)).toEqual([a, c]);
  });

  it('returns relative and absolute links for lists and detail', async () => {
    const { ctx, app } = makeApp({ publicBaseUrl: 'https://booru.example' });
    const id = seedPost(ctx, { md5: 'd'.repeat(32) });

    const list = await app.inject({ method: 'GET', url: '/api/v1/posts' });
    const item = list.json().posts[0];
    expect(list.json().baseUrl).toBe('https://booru.example');
    expect(item.url).toBe(`/i/${id}`);
    expect(item.thumbUrl).toBe(`/t/${id}?v=2`);
    expect(item.absoluteUrl).toBe(`https://booru.example/i/${id}`);
    expect(item.absoluteThumbUrl).toBe(`https://booru.example/t/${id}?v=2`);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${id}` });
    expect(detail.json().absoluteUrl).toBe(`https://booru.example/i/${id}`);
    expect(detail.json().baseUrl).toBe('https://booru.example');
  });

  it('serves an OpenAPI document that matches the cursor and upload API', async () => {
    const { app } = makeApp({ publicBaseUrl: 'https://booru.example' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('public');

    const spec = response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers).toEqual([{ url: 'https://booru.example' }]);
    expect(Object.keys(spec.paths['/api/v1/posts']).sort()).toEqual(['get', 'post']);
    const params = spec.paths['/api/v1/posts'].get.parameters.map(
      (param: { name: string }) => param.name,
    );
    expect(params).toEqual(
      expect.arrayContaining(['tags', 'rating_mode', 'after_id', 'before_id']),
    );
    expect(spec.components.securitySchemes.uploadToken.name).toBe('X-Upload-Token');
    expect(spec.components.schemas.PostListItem).toBeDefined();
  });

  it('allows read origins but never exposes session endpoints', async () => {
    const { ctx, app } = makeApp();
    seedPost(ctx, { md5: 'e'.repeat(32) });

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: { origin: 'https://client.example' },
    });
    expect(read.headers['access-control-allow-origin']).toBe('*');
    expect(read.headers['access-control-expose-headers']).toContain('Retry-After');

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { origin: 'https://client.example' },
    });
    expect(session.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/posts',
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toContain('GET');
  });

  it('narrows or disables CORS from config', async () => {
    const { ctx, app } = makeApp({ apiCorsOrigins: ['https://client.example'] });
    seedPost(ctx, { md5: 'f'.repeat(32) });

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: { origin: 'https://client.example' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://client.example');
    expect(allowed.headers.vary).toBe('Origin');

    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    const { app: noCors } = makeApp({ apiCorsOrigins: [] });
    const disabled = await noCors.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: { origin: 'https://client.example' },
    });
    expect(disabled.headers['access-control-allow-origin']).toBeUndefined();
  });
});
