import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createRemotePost, RemotePostError } from '../src/remote.js';
import {
  assertPublicUrl,
  createRemoteThumbService,
  isPublicAddress,
  ThumbCache,
} from '../src/remote-thumbs.js';
import { createTestContext } from './helpers.js';

async function samplePng(width = 1200, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#2b6cb0' } })
    .png()
    .toBuffer();
}

function createPost(
  ctx: ReturnType<typeof createTestContext>['ctx'],
  overrides: Record<string, unknown> = {},
) {
  return createRemotePost(ctx, {
    provider: 'danbooru',
    originId: '12345',
    pageUrl: 'https://danbooru.donmai.us/posts/12345',
    fileUrl: 'https://cdn.example/art.png',
    sourceUrl: 'https://www.pixiv.net/artworks/146828566',
    previewUrl: 'https://cdn.example/art-preview.png',
    mime: 'image/png',
    rating: 's',
    tags: 'artist:someone, flandre, solo',
    width: 1200,
    height: 900,
    bytes: 2_000_000,
    ...overrides,
  });
}

function serviceFor(
  ctx: ReturnType<typeof createTestContext>['ctx'],
  fetchImpl: typeof fetch,
  resolveHost = async () => ['93.184.216.34'],
) {
  return createRemoteThumbService(ctx, {
    fetchImpl,
    resolveHost,
    maxBytes: 1024 * 1024,
    timeoutMs: 2000,
  });
}

describe('remote posts', () => {
  it('creates an active post with an origin and categorized tags', () => {
    const { ctx } = createTestContext();
    const result = createPost(ctx);

    expect(result.duplicate).toBe(false);
    const post = ctx.sqlite
      .prepare(
        'SELECT storage_kind, status, mime, width, height, source_url FROM posts WHERE id = ?',
      )
      .get(result.postId) as Record<string, unknown>;
    expect(post).toMatchObject({
      storage_kind: 'remote',
      status: 'active',
      mime: 'image/png',
      width: 1200,
      height: 900,
      source_url: 'https://www.pixiv.net/artworks/146828566',
    });

    const origin = ctx.sqlite
      .prepare(
        'SELECT provider, page_url, file_url, preview_url, status FROM post_origins WHERE post_id = ?',
      )
      .get(result.postId) as Record<string, unknown>;
    expect(origin).toMatchObject({
      provider: 'danbooru',
      page_url: 'https://danbooru.donmai.us/posts/12345',
      file_url: 'https://cdn.example/art.png',
      preview_url: 'https://cdn.example/art-preview.png',
      status: 'ok',
    });

    const tags = ctx.sqlite
      .prepare(
        `SELECT t.name, t.category FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id = ? ORDER BY t.name`,
      )
      .all(result.postId) as Array<{ name: string; category: string }>;
    expect(tags.map((tag) => `${tag.category}:${tag.name}`)).toEqual([
      'general:flandre',
      'general:solo',
      'artist:someone',
    ]);
  });

  it('is idempotent for a parser retry and rejects unsupported media', () => {
    const { ctx } = createTestContext();
    const first = createPost(ctx);
    const second = createPost(ctx, {
      tags: 'extra',
      previewUrl: 'https://cdn.example/art-preview-720.webp',
    });

    expect(second).toMatchObject({ postId: first.postId, duplicate: true });
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get()).toMatchObject({
      count: 1,
    });
    expect(
      ctx.sqlite
        .prepare('SELECT preview_url AS previewUrl FROM post_origins WHERE post_id = ?')
        .get(first.postId),
    ).toMatchObject({ previewUrl: 'https://cdn.example/art-preview-720.webp' });

    expect(() => createPost(ctx, { originId: 'other', mime: 'image/svg+xml' })).toThrow(
      RemotePostError,
    );
    expect(() => createPost(ctx, { originId: 'third', fileUrl: 'file:///etc/passwd' })).toThrow(
      /http or https/,
    );
  });

  it('rejects private and malformed source addresses in the thumbnail fetcher', async () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('10.0.0.5')).toBe(false);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
    expect(isPublicAddress('::1')).toBe(false);

    await expect(
      assertPublicUrl('http://127.0.0.1/art.png', async () => ['93.184.216.34']),
    ).rejects.toThrow(/not public/);
    await expect(
      assertPublicUrl('https://internal.example/art.png', async () => ['10.0.0.5']),
    ).rejects.toThrow(/not public/);
    await expect(
      assertPublicUrl('https://cdn.example:8080/art.png', async () => ['93.184.216.34']),
    ).rejects.toThrow(/port/);
  });
});

describe('remote thumbnails', () => {
  it('renders and caches a 480px WebP without refetching', async () => {
    const { ctx } = createTestContext({ remoteThumbCacheMb: 1 });
    const postId = createPost(ctx).postId;
    const png = await samplePng();
    const fetchImpl = vi.fn(
      async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const service = serviceFor(ctx, fetchImpl as unknown as typeof fetch);

    const first = await service.get(postId);
    expect(first.contentType).toBe('image/webp');
    expect(first.cacheable).toBe(true);
    const meta = await sharp(first.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(360);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await service.get(postId);
    expect(second.etag).toBe(first.etag);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back from a dead preview to the full file', async () => {
    const { ctx } = createTestContext();
    const postId = createPost(ctx).postId;
    const png = await samplePng(600, 600);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('preview')) return new Response('gone', { status: 404 });
      return new Response(png, { status: 200 });
    });
    const service = serviceFor(ctx, fetchImpl as unknown as typeof fetch);

    const thumb = await service.get(postId);
    expect(thumb.cacheable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const origin = ctx.sqlite
      .prepare('SELECT status FROM post_origins WHERE post_id = ?')
      .get(postId);
    expect(origin).toMatchObject({ status: 'ok' });
  });

  it('marks a permanently dead file as source_dead and returns a placeholder once', async () => {
    const { ctx } = createTestContext();
    const postId = createPost(ctx).postId;
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const service = serviceFor(ctx, fetchImpl as unknown as typeof fetch);

    const thumb = await service.get(postId);
    expect(thumb.contentType).toBe('image/svg+xml');
    expect(thumb.cacheable).toBe(false);

    const origin = ctx.sqlite
      .prepare('SELECT status FROM post_origins WHERE post_id = ?')
      .get(postId);
    expect(origin).toMatchObject({ status: 'source_dead' });

    // The next request no longer contacts the dead source.
    await service.get(postId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not mark an origin dead after a temporary server error', async () => {
    const { ctx } = createTestContext();
    const postId = createPost(ctx).postId;
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 503 }));
    const service = serviceFor(ctx, fetchImpl as unknown as typeof fetch);

    const thumb = await service.get(postId);
    expect(thumb.contentType).toBe('image/svg+xml');
    const origin = ctx.sqlite
      .prepare('SELECT status FROM post_origins WHERE post_id = ?')
      .get(postId);
    expect(origin).toMatchObject({ status: 'ok' });

    await service.get(postId);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('rejects a redirect to a private address before following it', async () => {
    const { ctx } = createTestContext();
    const postId = createPost(ctx).postId;
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } }),
    );
    const service = serviceFor(ctx, fetchImpl as unknown as typeof fetch);

    const thumb = await service.get(postId);
    expect(thumb.contentType).toBe('image/svg+xml');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not fetch a host that resolves to a private address', async () => {
    const { ctx } = createTestContext();
    const postId = createPost(ctx).postId;
    const fetchImpl = vi.fn(async () => new Response('should not happen'));
    const service = serviceFor(ctx, fetchImpl as unknown as typeof fetch, async () => ['10.0.0.5']);

    const thumb = await service.get(postId);
    expect(thumb.contentType).toBe('image/svg+xml');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('evicts the least recently used preview when the cache is full', () => {
    const cache = new ThumbCache(10);
    cache.set(1, Buffer.alloc(5));
    cache.set(2, Buffer.alloc(5));
    expect(cache.bytes).toBe(10);
    cache.get(1);
    cache.set(3, Buffer.alloc(5));
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toHaveLength(5);
    expect(cache.get(3)).toHaveLength(5);
  });
});
