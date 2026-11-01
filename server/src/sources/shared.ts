import type { Rating } from '../search.js';

/**
 * Helpers shared by the source adapters. Boorus disagree on detail, not on
 * shape: a rating word, a space-separated tag string and a direct file URL.
 */

export const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * The engine only accepts classic 2D art. An adapter filters this locally in
 * addition to its search query: tags are checked after normalization so
 * `ai-generated`, `ai_generated` and similar spellings all match.
 */
export const BLOCKED_TAGS = new Set([
  'ai_generated',
  'ai_assisted',
  'ai_assisted_art',
  'ai_art',
  'ai_artwork',
  'stable_diffusion',
  'novelai',
  'midjourney',
  'dall_e',
  'dalle',
  'nijijourney',
  '3d',
  '3d_model',
  '3d_geometry',
  '3d_animation',
  '3d_artwork',
  '3d_(artwork)',
  'animated_3d',
  'mmd',
  'blender',
  'blender_(software)',
  'source_filmmaker',
  'photorealistic',
]);

/**
 * Danbooru and Gelbooru both use `general`/`sensitive`/`questionable`/`explicit`,
 * while their short codes differ slightly (`s` is sensitive on Danbooru and
 * "questionable-ish" on older boards). Both map onto our three ratings.
 */
const RATINGS: Record<string, Rating> = {
  g: 's',
  general: 's',
  safe: 's',
  s: 'q',
  sensitive: 'q',
  q: 'q',
  questionable: 'q',
  e: 'e',
  explicit: 'e',
};

export function splitTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/\s+/)
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean);
}

export function normalizeRating(value: unknown): Rating | null {
  return RATINGS[String(value).trim().toLowerCase()] ?? null;
}

export function isBlockedTags(tags: string[]): boolean {
  return tags.some((tag) => {
    const name = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag;
    return BLOCKED_TAGS.has(name.replace(/-/g, '_'));
  });
}

export function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function absoluteHttpUrl(value: unknown, baseUrl?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Derives the media type from the file URL when the API does not report one. */
export function imageMimeFromUrl(url: string): string | null {
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase();
    return ext ? (IMAGE_EXTENSIONS[ext] ?? null) : null;
  } catch {
    return null;
  }
}

export function sourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.match(
    /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']+/i,
  );
  if (!match) return null;
  let raw = match[0].replace(/[)\]}.,;]+$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Danbooru/Gelbooru often store the Pixiv CDN file as `source`. Turn it back
    // into the artist page so the UI shows `pixiv.net/artworks/...`.
    if (url.hostname === 'i.pximg.net' || url.hostname.endsWith('.pximg.net')) {
      const id = url.pathname.match(/\/(\d+)_p\d+/)?.[1] ?? url.pathname.match(/\/(\d+)\./)?.[1];
      if (id) return `https://www.pixiv.net/artworks/${id}`;
    }
    if (url.hostname === 'pixiv.net') url.hostname = 'www.pixiv.net';
    return url.toString();
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
