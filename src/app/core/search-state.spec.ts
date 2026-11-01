import { describe, expect, it } from 'vitest';
import { normalizeSearchQuery, splitSearchQuery } from './search-state';

describe('search query splitter', () => {
  it('treats commas as separators between tags', () => {
    expect(splitSearchQuery('pixel art, sign')).toEqual(['pixel', 'art', 'sign']);
    expect(splitSearchQuery('pixel_art, sign')).toEqual(['pixel_art', 'sign']);
    expect(splitSearchQuery('pixel,art')).toEqual(['pixel', 'art']);
    expect(splitSearchQuery('-tag,')).toEqual(['-tag']);
  });

  it('keeps commas inside rating and order filters', () => {
    expect(splitSearchQuery('rating:s,q -art,')).toEqual(['rating:s,q', '-art']);
    expect(splitSearchQuery('-rating:e,q')).toEqual(['-rating:e,q']);
    expect(splitSearchQuery('order:score,')).toEqual(['order:score']);
  });

  it('normalizes a typed query before it reaches the URL and chips', () => {
    expect(normalizeSearchQuery('  pixel art,  sign ')).toBe('pixel art sign');
    expect(normalizeSearchQuery(' , ')).toBe('');
  });
});
