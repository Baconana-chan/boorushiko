import { describe, expect, it } from 'vitest';
import { parseSearch, queryPosts, searchTags } from '../src/search.js';
import { createTestContext, seedPost } from './helpers.js';

describe('parseSearch', () => {
  it('parses includes, exclusions and meta filters', () => {
    const query = parseSearch('flandre solo -rating:e order:score score:>4');
    expect(query.include.map((token) => token.name)).toEqual(['flandre', 'solo']);
    expect(query.excludeRatings).toEqual(['e']);
    expect(query.order).toBe('score');
    expect(query.scoreMin).toBe(4);
  });

  it('supports category prefixes and wildcards', () => {
    const query = parseSearch('artist:foo ~bar*');
    expect(query.include[0]).toEqual({ name: 'foo', wildcard: false });
    expect(query.include[1]).toEqual({ name: 'bar*', wildcard: true });
  });

  it('rejects unknown ratings and orders', () => {
    expect(() => parseSearch('rating:x')).toThrow(/unknown rating/);
    expect(() => parseSearch('order:hot')).toThrow(/unknown order/);
    expect(() => parseSearch('score:10')).toThrow(/score:>10/);
  });
});

describe('queryPosts', () => {
  function seed() {
    const { ctx } = createTestContext();
    seedPost(ctx, {
      md5: 'a'.repeat(32),
      tags: ['flandre', 'solo'],
      score: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seedPost(ctx, {
      md5: 'b'.repeat(32),
      tags: ['flandre'],
      rating: 'q',
      score: 5,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    seedPost(ctx, {
      md5: 'c'.repeat(32),
      tags: ['remilia', 'solo'],
      rating: 'e',
      score: 50,
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    seedPost(ctx, {
      md5: 'd'.repeat(32),
      tags: ['flandre', 'solo'],
      rating: 'e',
      score: 1,
      createdAt: '2026-01-04T00:00:00.000Z',
    });
    return ctx;
  }

  it('matches every included tag and respects exclusions', () => {
    const ctx = seed();
    const onlyFlandre = queryPosts(ctx.sqlite, parseSearch('flandre'), { limit: 20, offset: 0 });
    expect(onlyFlandre.posts).toHaveLength(3);

    const withoutSolo = queryPosts(ctx.sqlite, parseSearch('flandre -solo'), {
      limit: 20,
      offset: 0,
    });
    expect(withoutSolo.posts.map((post) => post.md5[0])).toEqual(['b']);
  });

  it('filters by rating and orders the page', () => {
    const ctx = seed();
    const safe = queryPosts(ctx.sqlite, parseSearch('flandre rating:s,q'), {
      limit: 20,
      offset: 0,
    });
    expect(safe.posts.map((post) => post.md5[0])).toEqual(['b', 'a']);

    const byScore = queryPosts(ctx.sqlite, parseSearch('flandre order:score'), {
      limit: 20,
      offset: 0,
    });
    expect(byScore.posts.map((post) => post.score)).toEqual([10, 5, 1]);
  });

  it('supports wildcard prefixes and pagination', () => {
    const ctx = seed();
    const wildcard = queryPosts(ctx.sqlite, parseSearch('flan*'), { limit: 20, offset: 0 });
    expect(wildcard.posts).toHaveLength(3);

    const firstPage = queryPosts(ctx.sqlite, parseSearch('flandre order:score'), {
      limit: 1,
      offset: 0,
    });
    expect(firstPage.posts).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
  });

  it('returns tags with each post', () => {
    const ctx = seed();
    const result = queryPosts(ctx.sqlite, parseSearch('remilia'), { limit: 20, offset: 0 });
    expect(result.posts[0]?.tags.map((tag) => tag.name).sort()).toEqual(['remilia', 'solo']);
  });

  it('filters posts with sensitive tags only when asked to', () => {
    const { ctx } = createTestContext();
    const normalId = seedPost(ctx, { md5: 'e'.repeat(32), tags: ['flandre', 'solo'] });
    const sensitiveId = seedPost(ctx, { md5: 'f'.repeat(32), tags: ['flandre', 'shota'] });
    const wildcardId = seedPost(ctx, { md5: 'g'.repeat(32), tags: ['flandre', 'lolicon'] });

    const hidden = queryPosts(ctx.sqlite, parseSearch('flandre'), {
      limit: 20,
      offset: 0,
      includeSensitive: false,
      sensitiveTags: ctx.config.sensitiveTags,
    });
    expect(hidden.posts.map((post) => post.id)).toEqual([normalId]);

    const shown = queryPosts(ctx.sqlite, parseSearch('flandre'), {
      limit: 20,
      offset: 0,
      includeSensitive: true,
      sensitiveTags: ctx.config.sensitiveTags,
    });
    expect(shown.posts.map((post) => post.id).sort()).toEqual(
      [normalId, sensitiveId, wildcardId].sort(),
    );
  });

  it('joins multi-word queries into an underscore tag', () => {
    const { ctx } = createTestContext();
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pixel_art', 'solo'] });
    seedPost(ctx, { md5: 'f'.repeat(32), tags: ['pixel', 'art'] });

    const result = queryPosts(ctx.sqlite, parseSearch('PIXEL ART'), { limit: 20, offset: 0 });
    expect(result.posts.map((post) => post.md5[0])).toEqual(['e']);
  });

  it('keeps an exact tag exact; percent opts into substring matching', () => {
    const { ctx } = createTestContext();
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pixel_art'] });
    seedPost(ctx, { md5: 'f'.repeat(32), tags: ['pixel'] });

    const exact = queryPosts(ctx.sqlite, parseSearch('pixel'), { limit: 20, offset: 0 });
    expect(exact.posts.map((post) => post.md5[0])).toEqual(['f']);

    const relative = queryPosts(ctx.sqlite, parseSearch('%pixel%'), { limit: 20, offset: 0 });
    expect(relative.posts.map((post) => post.md5[0]).sort()).toEqual(['e', 'f']);
  });

  it('keeps phrases together next to other tags and commas', () => {
    const { ctx } = createTestContext();
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pixel_art', 'sign'] });
    seedPost(ctx, { md5: 'f'.repeat(32), tags: ['pixel', 'art', 'sign'] });

    const plain = queryPosts(ctx.sqlite, parseSearch('pixel art sign'), { limit: 20, offset: 0 });
    expect(plain.posts.map((post) => post.md5[0])).toEqual(['e']);

    const comma = queryPosts(ctx.sqlite, parseSearch('pixel art, sign'), { limit: 20, offset: 0 });
    expect(comma.posts.map((post) => post.md5[0])).toEqual(['e']);
  });

  it('falls back to a substring match when no exact tag exists', () => {
    const { ctx } = createTestContext();
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pixel_art'] });

    const result = queryPosts(ctx.sqlite, parseSearch('pixel_a'), { limit: 20, offset: 0 });
    expect(result.posts.map((post) => post.md5[0])).toEqual(['e']);
  });

  it('treats percent and asterisk as wildcards', () => {
    const { ctx } = createTestContext();
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pixel_art'] });
    seedPost(ctx, { md5: 'f'.repeat(32), tags: ['art'] });
    seedPost(ctx, { md5: 'g'.repeat(32), tags: ['pixel'] });

    const middle = queryPosts(ctx.sqlite, parseSearch('pixel%art'), { limit: 20, offset: 0 });
    expect(middle.posts.map((post) => post.md5[0])).toEqual(['e']);

    const contains = queryPosts(ctx.sqlite, parseSearch('%art%'), { limit: 20, offset: 0 });
    expect(contains.posts.map((post) => post.md5[0]).sort()).toEqual(['e', 'f']);

    const prefix = queryPosts(ctx.sqlite, parseSearch('pixel*'), { limit: 20, offset: 0 });
    expect(prefix.posts.map((post) => post.md5[0]).sort()).toEqual(['e', 'g']);
  });
});

describe('searchTags', () => {
  it('matches spaces, underscores and partial input, exact and prefix first', () => {
    const { ctx } = createTestContext();
    seedPost(ctx, { md5: 'e'.repeat(32), tags: ['pixel_art'] });
    seedPost(ctx, { md5: 'f'.repeat(32), tags: ['pixel'] });

    expect(searchTags(ctx.sqlite, 'pixel art', 5).map((tag) => tag.name)).toEqual(['pixel_art']);
    expect(searchTags(ctx.sqlite, 'pix', 5).map((tag) => tag.name)).toEqual(['pixel', 'pixel_art']);
    expect(searchTags(ctx.sqlite, 'PIXEL', 5).map((tag) => tag.name)).toEqual([
      'pixel',
      'pixel_art',
    ]);
  });
});
