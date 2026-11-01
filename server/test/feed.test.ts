import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp() {
  const context = createTestContext({ publicBaseUrl: 'https://booru.test' });
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

describe('RSS feed', () => {
  it('lists active safe and sensitive posts but never explicit ones', async () => {
    const { app, ctx } = makeApp();
    const safe = seedPost(ctx, { md5: 'a'.repeat(32), tags: ['flandre', 'touhou'] });
    const questionable = seedPost(ctx, { md5: 'b'.repeat(32), tags: ['beach'], rating: 'q' });
    const explicit = seedPost(ctx, { md5: 'c'.repeat(32), tags: ['nsfw'], rating: 'e' });
    seedPost(ctx, { md5: 'd'.repeat(32), tags: ['loli'] });
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pending'], status: 'pending' });

    const response = await app.inject({ method: 'GET', url: '/feed.xml' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/rss+xml');

    const xml = response.body;
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain(`https://booru.test/post/${safe}`);
    expect(xml).toContain(`https://booru.test/post/${questionable}`);
    expect(xml).not.toContain(`https://booru.test/post/${explicit}`);
    expect(xml).not.toContain('https://booru.test/post/4');
    expect(xml).not.toContain('https://booru.test/post/5');
    // Only the general-rated post gets a thumbnail in the feed.
    expect(xml).toContain(`https://booru.test/t/${safe}`);
    expect(xml).not.toContain(`https://booru.test/t/${questionable}`);
  });
});

describe('OG preview', () => {
  it('exposes meta tags for a general post', async () => {
    const { app, ctx } = makeApp();
    const id = seedPost(ctx, {
      md5: 'f'.repeat(32),
      tags: ['flandre', 'touhou', 'art_x'],
      categories: { flandre: 'character', touhou: 'copyright', art_x: 'artist' },
    });

    const response = await app.inject({ method: 'GET', url: `/post/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('property="og:title"');
    expect(response.body).toContain('flandre');
    expect(response.body).toContain(`property="og:image" content="https://booru.test/t/${id}"`);
    expect(response.body).toContain(`rel="canonical" href="https://booru.test/post/${id}"`);
    expect(response.body).not.toContain('noindex');
  });

  it('keeps explicit posts out of previews', async () => {
    const { app, ctx } = makeApp();
    const id = seedPost(ctx, { md5: '0'.repeat(32), tags: ['secret_tag'], rating: 'e' });

    const response = await app.inject({ method: 'GET', url: `/post/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('noindex');
    expect(response.body).not.toContain('og:image');
    expect(response.body).not.toContain('secret_tag');
    expect(response.body).toContain('adults only');
  });

  it('treats a sensitive-tagged post like an explicit one', async () => {
    const { app, ctx } = makeApp();
    const id = seedPost(ctx, { md5: '9'.repeat(32), tags: ['loli', 'flandre'], rating: 's' });

    const response = await app.inject({ method: 'GET', url: `/post/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('noindex');
    expect(response.body).not.toContain('og:image');
    expect(response.body).not.toContain('loli');
  });

  it('answers 404 for a missing post without leaking internals', async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: 'GET', url: '/post/999' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('noindex');
  });
});
