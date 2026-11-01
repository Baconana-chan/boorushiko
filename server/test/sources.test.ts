import { describe, expect, it, vi } from 'vitest';
import { importFromSource } from '../src/sources/importer.js';
import { DanbooruSource, parseDanbooruPost } from '../src/sources/danbooru.js';
import { GelbooruSource, parseGelbooruPost } from '../src/sources/gelbooru.js';
import { createSource } from '../src/sources/index.js';
import type { BooruSource, SourcePost } from '../src/sources/types.js';
import { createTestContext } from './helpers.js';

const basePost = {
  id: 42,
  rating: 's',
  file_ext: 'png',
  file_url: '/original/42.png',
  source: 'https://www.pixiv.net/artworks/146828566',
  preview_file_url: '/preview/42.jpg',
  image_width: 1200,
  image_height: 900,
  file_size: 1500000,
  tag_string_general: 'solo hat',
  tag_string_artist: 'someone',
  tag_string_character: 'flandre_(touhou)',
  tag_string_copyright: 'touhou_project',
  tag_string_meta: 'highres',
};

function sourcePost(overrides: Partial<SourcePost> = {}): SourcePost {
  return {
    provider: 'fake',
    originId: '1',
    pageUrl: 'https://source.example/posts/1',
    fileUrl: 'https://source.example/art.png',
    previewUrl: 'https://source.example/art-preview.png',
    mime: 'image/png',
    rating: 's',
    tags: ['flandre', 'solo'],
    width: 1000,
    height: 1000,
    bytes: 1000,
    ...overrides,
  };
}

describe('Danbooru source', () => {
  it('maps posts, resolves relative URLs and keeps tag categories', () => {
    const post = parseDanbooruPost(basePost);
    expect(post).toMatchObject({
      provider: 'danbooru',
      originId: '42',
      pageUrl: 'https://danbooru.donmai.us/posts/42',
      fileUrl: 'https://danbooru.donmai.us/original/42.png',
      sourceUrl: 'https://www.pixiv.net/artworks/146828566',
      previewUrl: 'https://danbooru.donmai.us/preview/42.jpg',
      mime: 'image/png',
      rating: 'q',
      width: 1200,
      height: 900,
      bytes: 1500000,
    });
    expect(post?.tags).toEqual([
      'solo',
      'hat',
      'artist:someone',
      'character:flandre_(touhou)',
      'copyright:touhou_project',
      'meta:highres',
    ]);
    expect(post?.tags.some((tag) => tag.startsWith('general:'))).toBe(false);
  });

  it('does not duplicate a tag that appears in general and a specific category', () => {
    const post = parseDanbooruPost({
      ...basePost,
      tag_string_general: 'solo original',
      tag_string_copyright: 'original',
    });
    expect(post?.tags.filter((tag) => tag.endsWith(':original') || tag === 'original')).toEqual([
      'copyright:original',
    ]);
  });

  it('accepts a source URL without a scheme and ignores non-URL source text', () => {
    expect(
      parseDanbooruPost({ ...basePost, source: 'pixiv.net/artworks/146828566' })?.sourceUrl,
    ).toBe('https://www.pixiv.net/artworks/146828566');
    expect(parseDanbooruPost({ ...basePost, source: 'pixiv' })?.sourceUrl).toBeUndefined();
    expect(
      parseDanbooruPost({
        ...basePost,
        source: 'https://i.pximg.net/img-original/img/2026/07/05/03/43/29/146828566_p0.jpg',
      })?.sourceUrl,
    ).toBe('https://www.pixiv.net/artworks/146828566');
  });

  it('falls back to a media variant when preview URLs are missing', () => {
    const post = parseDanbooruPost({
      ...basePost,
      preview_file_url: null,
      large_file_url: null,
      media_asset: {
        variants: [{ type: '360x360', url: 'https://cdn.example/360.jpg' }],
      },
    });
    expect(post?.previewUrl).toBe('https://cdn.example/360.jpg');
  });

  it('filters AI/3D, deleted, pending and unsupported media', () => {
    expect(parseDanbooruPost({ ...basePost, tag_string_general: 'solo ai-generated' })).toBeNull();
    expect(parseDanbooruPost({ ...basePost, tag_string_meta: '3d' })).toBeNull();
    expect(parseDanbooruPost({ ...basePost, is_pending: true })).toBeNull();
    expect(parseDanbooruPost({ ...basePost, is_deleted: true })).toBeNull();
    expect(parseDanbooruPost({ ...basePost, file_ext: 'zip' })).toBeNull();
    expect(parseDanbooruPost({ ...basePost, rating: '?' })).toBeNull();
  });

  it('passes caller tags without forcing a rating filter', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([basePost]), { status: 200 }));
    const source = new DanbooruSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    const result = await source.fetchPage({ page: 1, limit: 1, tags: 'solo' });
    expect(result.posts).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('42');

    const [request] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.pathname).toBe('/posts.json');
    expect(url.searchParams.get('tags')).toBe('solo');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it('returns all ratings when the caller gives no tags', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const source = new DanbooruSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await source.fetchPage({ page: 1, limit: 10 });
    const [request] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.searchParams.has('tags')).toBe(false);
  });

  it('does not duplicate an explicit rating filter and uses the id cursor', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const source = new DanbooruSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await source.fetchPage({ page: 2, limit: 10, tags: '-rating:e rating:q', cursor: '900' });
    const [request] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.searchParams.get('tags')).toBe('-rating:e rating:q id:<900');
    expect(url.searchParams.get('page')).toBe('1');
  });

  it('uses ascending id polling for incremental head imports', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([basePost]), { status: 200 }));
    const source = new DanbooruSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    const result = await source.fetchPage({
      page: 1,
      limit: 10,
      tags: 'rating:g',
      since: '900',
    });
    expect(result.cursor).toBeUndefined();
    const [request] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.searchParams.get('tags')).toBe('rating:g id:>900 order:id');
    expect(url.searchParams.get('page')).toBe('1');
  });

  it('retries rate limits and gives up on repeated server errors', async () => {
    const limited = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([basePost]), { status: 200 }));
    const waits: number[] = [];
    const source = new DanbooruSource({
      fetchImpl: limited as unknown as typeof fetch,
      maxRetries: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const result = await source.fetchPage({ page: 1, limit: 1 });
    expect(result.posts).toHaveLength(1);
    expect(limited).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1000]);

    const broken = vi.fn(async () => new Response('down', { status: 503 }));
    const brokenSource = new DanbooruSource({
      fetchImpl: broken as unknown as typeof fetch,
      maxRetries: 1,
      sleep: async () => undefined,
    });
    await expect(brokenSource.fetchPage({ page: 1, limit: 1 })).rejects.toThrow(/HTTP 503/);
    expect(broken).toHaveBeenCalledTimes(2);
  });

  it('is available through the source factory', () => {
    expect(createSource('danbooru')).toBeInstanceOf(DanbooruSource);
    expect(() => createSource('unknown')).toThrow(/unknown source/);
  });
});

const gelbooruPost = {
  id: 9001,
  rating: 'questionable',
  status: 'active',
  file_url: 'https://img3.gelbooru.com/images/aa/bb/9001.png',
  preview_url: 'https://img3.gelbooru.com/thumbnails/aa/bb/thumbnail_9001.jpg',
  sample_url: 'https://img3.gelbooru.com/samples/aa/bb/sample_9001.jpg',
  source: 'https://www.pixiv.net/artworks/146828566',
  tags: 'solo hat someone',
  width: 1200,
  height: 900,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: URL };

/** Routes DAPI post and tag requests to separate canned answers. */
function gelbooruFetch(
  posts: unknown[],
  tags: unknown[] = [],
  calls: Call[] = [],
  status = 200,
): typeof fetch {
  return (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push({ url });
    if (status !== 200) return json({ error: 'nope' }, status);
    return json(url.searchParams.get('s') === 'tag' ? tags : posts);
  }) as unknown as typeof fetch;
}

describe('Gelbooru source', () => {
  it('maps a DAPI post, preferring the sample preview and the Pixiv source', () => {
    const post = parseGelbooruPost(gelbooruPost);
    expect(post).toMatchObject({
      provider: 'gelbooru',
      originId: '9001',
      pageUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=9001',
      fileUrl: 'https://img3.gelbooru.com/images/aa/bb/9001.png',
      previewUrl: 'https://img3.gelbooru.com/samples/aa/bb/sample_9001.jpg',
      sourceUrl: 'https://www.pixiv.net/artworks/146828566',
      mime: 'image/png',
      rating: 'q',
      width: 1200,
      height: 900,
    });
    expect(post?.tags).toEqual(['solo', 'hat', 'someone']);
  });

  it('filters AI/3D, deleted, rated and unsupported media', () => {
    expect(parseGelbooruPost({ ...gelbooruPost, tags: 'solo ai_generated' })).toBeNull();
    expect(parseGelbooruPost({ ...gelbooruPost, tags: 'solo 3d' })).toBeNull();
    expect(parseGelbooruPost({ ...gelbooruPost, status: 'deleted' })).toBeNull();
    expect(parseGelbooruPost({ ...gelbooruPost, rating: '?' })).toBeNull();
    expect(
      parseGelbooruPost({ ...gelbooruPost, file_url: 'https://img3.gelbooru.com/v/1.webm' }),
    ).toBeNull();
  });

  it('sends pid, limit and the account credentials, then advances by page', async () => {
    const calls: Call[] = [];
    const source = new GelbooruSource({
      apiKey: 'key-123',
      userId: '4567',
      fetchImpl: gelbooruFetch([gelbooruPost], [], calls),
      sleep: async () => undefined,
      tagCategories: () =>
        new Map([
          ['solo', 'general'],
          ['hat', 'general'],
          ['someone', 'artist'],
        ]),
    });

    const result = await source.fetchPage({ page: 2, limit: 50, tags: 'rating:general solo' });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.tags).toEqual(['solo', 'hat', 'artist:someone']);
    expect(result.cursor).toBeUndefined();
    expect(result.hasMore).toBe(false);

    expect(calls[0]!.url.pathname).toBe('/index.php');
    expect(calls[0]!.url.searchParams.get('page')).toBe('dapi');
    expect(calls[0]!.url.searchParams.get('s')).toBe('post');
    expect(calls[0]!.url.searchParams.get('json')).toBe('1');
    expect(calls[0]!.url.searchParams.get('pid')).toBe('1');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('50');
    expect(calls[0]!.url.searchParams.get('tags')).toBe('rating:general solo');
    expect(calls[0]!.url.searchParams.get('api_key')).toBe('key-123');
    expect(calls[0]!.url.searchParams.get('user_id')).toBe('4567');
  });

  it('starts at pid 0 and returns the next cursor for full pages', async () => {
    const calls: Call[] = [];
    const source = new GelbooruSource({
      fetchImpl: gelbooruFetch([gelbooruPost, { ...gelbooruPost, id: 9002 }], [], calls),
      sleep: async () => undefined,
      tagCategories: (names) => new Map(names.map((name) => [name, 'general'])),
    });

    const result = await source.fetchPage({ page: 1, limit: 2 });
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('1');
    expect(calls[0]!.url.searchParams.get('pid')).toBe('0');

    await source.fetchPage({ page: 1, limit: 2, cursor: '7' });
    expect(calls[1]!.url.searchParams.get('pid')).toBe('7');
  });

  it('resolves missing tag categories from the tag endpoint', async () => {
    const calls: Call[] = [];
    const source = new GelbooruSource({
      fetchImpl: gelbooruFetch(
        [gelbooruPost],
        [
          { id: 1, name: 'solo', type: 0 },
          { id: 2, name: 'hat', type: 5 },
          { id: 3, name: 'someone', type: 1 },
        ],
        calls,
      ),
      sleep: async () => undefined,
    });

    const result = await source.fetchPage({ page: 1, limit: 1 });
    expect(result.posts[0]?.tags).toEqual(['solo', 'meta:hat', 'artist:someone']);
    const tagUrl = calls.find((call) => call.url.searchParams.get('s') === 'tag')!.url;
    expect(tagUrl.searchParams.get('names')?.split(' ').sort()).toEqual(['hat', 'solo', 'someone']);
    expect(tagUrl.searchParams.get('limit')).toBe('100');
  });

  it('does not mislabel tags when the tag endpoint ignores `names`', async () => {
    const calls: Call[] = [];
    const source = new GelbooruSource({
      fetchImpl: gelbooruFetch([gelbooruPost], [{ name: 'unrelated', type: 1 }], calls),
      sleep: async () => undefined,
    });

    const result = await source.fetchPage({ page: 1, limit: 1 });
    expect(result.posts[0]?.tags).toEqual(['solo', 'hat', 'someone']);
    expect(calls.filter((call) => call.url.searchParams.get('s') === 'tag')).toHaveLength(1);
  });

  it('stops at the head watermark instead of walking the archive', async () => {
    const calls: Call[] = [];
    const source = new GelbooruSource({
      fetchImpl: gelbooruFetch([{ ...gelbooruPost, id: 9010 }, gelbooruPost], [], calls),
      sleep: async () => undefined,
      tagCategories: (names) => new Map(names.map((name) => [name, 'general'])),
    });

    const result = await source.fetchPage({ page: 1, limit: 2, since: '9001' });
    expect(result.posts.map((post) => post.originId)).toEqual(['9010']);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeUndefined();
  });

  it('explains a 401 as missing credentials', async () => {
    const source = new GelbooruSource({
      fetchImpl: gelbooruFetch([], [], [], 401),
      sleep: async () => undefined,
    });
    await expect(source.fetchPage({ page: 1, limit: 1 })).rejects.toThrow(
      /GELBOORU_API_KEY and GELBOORU_USER_ID/,
    );
  });

  it('is available through the source factory', () => {
    expect(createSource('gelbooru')).toBeInstanceOf(GelbooruSource);
    expect(createSource('GELBOORU')).toBeInstanceOf(GelbooruSource);
  });
});

describe('source importer', () => {
  function fakeSource(posts: SourcePost[], hasMore = false): BooruSource {
    return {
      name: 'fake',
      async fetchPage() {
        return { posts, hasMore };
      },
    };
  }

  it('imports posts, counts duplicates and respects the limit', async () => {
    const { ctx } = createTestContext();
    const source = fakeSource([
      sourcePost({ originId: '1' }),
      sourcePost({ originId: '2' }),
      sourcePost({ originId: '3' }),
    ]);

    const first = await importFromSource(ctx, source, {
      limit: 2,
      pageSize: 3,
      delayMs: 0,
    });
    expect(first).toMatchObject({ imported: 2, duplicates: 0, failed: 0, seen: 2 });
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get()).toMatchObject({
      count: 2,
    });

    const second = await importFromSource(ctx, source, {
      limit: 2,
      pageSize: 3,
      delayMs: 0,
    });
    expect(second).toMatchObject({ imported: 0, duplicates: 2, failed: 0 });
  });

  it('keeps going when one post is invalid', async () => {
    const { ctx } = createTestContext();
    const source = fakeSource([
      sourcePost({ originId: 'bad', mime: 'image/svg+xml' }),
      sourcePost({ originId: 'good' }),
    ]);

    const stats = await importFromSource(ctx, source, {
      limit: 2,
      pageSize: 2,
      delayMs: 0,
    });
    expect(stats).toMatchObject({ imported: 1, failed: 1, seen: 2 });
    expect(stats.failures[0]?.originId).toBe('bad');
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get()).toMatchObject({
      count: 1,
    });
  });

  it('passes a cursor to the next page instead of incrementing the offset', async () => {
    const { ctx } = createTestContext();
    const calls: Array<{ page: number; cursor?: string }> = [];
    const source: BooruSource = {
      name: 'cursor-fake',
      async fetchPage(request) {
        calls.push({ page: request.page, cursor: request.cursor });
        if (!request.cursor) {
          return {
            posts: [sourcePost({ originId: '1' })],
            hasMore: true,
            cursor: '1',
          };
        }
        return {
          posts: [sourcePost({ originId: '2' })],
          hasMore: false,
          cursor: '2',
        };
      },
    };

    const stats = await importFromSource(ctx, source, {
      limit: 2,
      pageSize: 1,
      delayMs: 0,
    });
    expect(stats.imported).toBe(2);
    expect(calls).toEqual([
      { page: 1, cursor: undefined },
      { page: 1, cursor: '1' },
    ]);
  });

  it('passes the incremental watermark and records the newest id', async () => {
    const { ctx } = createTestContext();
    const requests: Array<{ since?: string }> = [];
    const source: BooruSource = {
      name: 'since-fake',
      async fetchPage(request) {
        requests.push({ since: request.since });
        return {
          posts: [sourcePost({ originId: '11' })],
          hasMore: false,
        };
      },
    };

    const stats = await importFromSource(ctx, source, {
      limit: 1,
      pageSize: 1,
      since: '10',
      delayMs: 0,
    });
    expect(requests).toEqual([{ since: '10' }]);
    expect(stats).toMatchObject({ imported: 1, newestOriginId: '11', oldestOriginId: '11' });
  });

  it('stops when the source has no more pages', async () => {
    const { ctx } = createTestContext();
    const source = fakeSource([sourcePost()], false);
    const stats = await importFromSource(ctx, source, {
      limit: 20,
      pageSize: 50,
      delayMs: 0,
    });
    expect(stats).toMatchObject({ seen: 1, imported: 1, pages: 1 });
  });

  it('uses the engine remote endpoint shape', async () => {
    const { ctx } = createTestContext();
    const source = fakeSource([sourcePost()]);
    await importFromSource(ctx, source, { limit: 1, delayMs: 0 });
    const post = ctx.sqlite.prepare('SELECT storage_kind, status FROM posts').get() as {
      storage_kind: string;
      status: string;
    };
    expect(post).toEqual({ storage_kind: 'remote', status: 'active' });
    const origin = ctx.sqlite.prepare('SELECT provider, page_url FROM post_origins').get() as {
      provider: string;
      page_url: string;
    };
    expect(origin).toEqual({ provider: 'fake', page_url: 'https://source.example/posts/1' });
  });
});
