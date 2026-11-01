import {
  absoluteHttpUrl,
  asRecord,
  imageMimeFromUrl,
  isBlockedTags,
  normalizeRating,
  positiveNumber,
  sourceUrl,
  splitTags,
} from './shared.js';
import {
  SourceError,
  type BooruSource,
  type SourceHttpOptions,
  type SourcePage,
  type SourcePageRequest,
  type SourcePost,
} from './types.js';

const DEFAULT_BASE_URL = 'https://gelbooru.com';
const DEFAULT_USER_AGENT = 'BoorushikoBot/0.1 (booru importer)';
/** Gelbooru's hard ceiling per request, also for the tag endpoint. */
const MAX_PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const TAG_BATCH_SIZE = 100;
const TAG_BATCH_PAUSE_MS = 120;

/**
 * Gelbooru tag types: 0 general, 1 artist, 3 copyright, 4 character,
 * 5 metadata (2 is an unused legacy value; keep it general).
 */
const TAG_TYPE_CATEGORIES: Record<string, string> = {
  '0': 'general',
  '1': 'artist',
  '2': 'general',
  '3': 'copyright',
  '4': 'character',
  '5': 'meta',
};

interface GelbooruRawPost {
  id?: unknown;
  rating?: unknown;
  status?: unknown;
  file_url?: unknown;
  preview_url?: unknown;
  sample_url?: unknown;
  source?: unknown;
  tags?: unknown;
  width?: unknown;
  height?: unknown;
  file_size?: unknown;
}

export interface GelbooruParseOptions {
  baseUrl?: string;
  /** Resolved tag categories; unknown names stay `general`. */
  categoryOf?: (name: string) => string | undefined;
}

/**
 * Gelbooru's DAPI answers with either a bare array (newer builds and forks)
 * or an `{"@attributes": {...}, "post": [...]}` wrapper. An empty result may
 * also be an object without the key at all.
 */
function gelbooruItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (!record) return [];
  for (const key of ['post', 'tag'] as const) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value !== undefined && value !== null) return [value];
  }
  return [];
}

/** Map one Gelbooru DAPI item to the engine's source format. */
export function parseGelbooruPost(
  value: unknown,
  options: GelbooruParseOptions = {},
): SourcePost | null {
  const raw = asRecord(value) as GelbooruRawPost | null;
  if (!raw) return null;

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const id = positiveNumber(raw.id);
  if (!id) return null;

  // Deleted/pending posts show up in some queries; only `active` is imported.
  const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
  if (status && status !== 'active') return null;

  const fileUrl = absoluteHttpUrl(raw.file_url, baseUrl);
  if (!fileUrl) return null;
  const mime = imageMimeFromUrl(fileUrl);
  if (!mime) return null;

  const rating = normalizeRating(raw.rating);
  if (!rating) return null;

  const names = splitTags(raw.tags);
  if (isBlockedTags(names)) return null;

  const categoryOf = options.categoryOf;
  const tags = names.map((name) => {
    const category = categoryOf?.(name);
    return category && category !== 'general' ? `${category}:${name}` : name;
  });

  // `sample` is Gelbooru's ~1280px copy: the 150px `preview` is too soft for
  // the grid, and the original is far too heavy for a hover preview.
  const previewUrl =
    absoluteHttpUrl(raw.sample_url, baseUrl) ?? absoluteHttpUrl(raw.preview_url, baseUrl);

  const artistSource = sourceUrl(raw.source);

  return {
    provider: 'gelbooru',
    originId: String(id),
    pageUrl: `${baseUrl}/index.php?page=post&s=view&id=${id}`,
    fileUrl,
    ...(artistSource ? { sourceUrl: artistSource } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    mime,
    rating,
    tags,
    ...(positiveNumber(raw.width) ? { width: positiveNumber(raw.width) } : {}),
    ...(positiveNumber(raw.height) ? { height: positiveNumber(raw.height) } : {}),
    ...(positiveNumber(raw.file_size) ? { bytes: positiveNumber(raw.file_size) } : {}),
  };
}

/**
 * Gelbooru does not put tag categories in the post list, so they come from its
 * tag endpoint. Only names we do not already know are asked for, in batches of
 * 100, and a lookup that answers with unrelated names (an older fork ignoring
 * `names`) disables lookups for the rest of the run instead of mislabelling tags.
 */
export class GelbooruSource implements BooruSource {
  readonly name = 'gelbooru';

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiKey?: string;
  private readonly userId?: string;
  private readonly knownCategories: (names: string[]) => Map<string, string>;
  private readonly categoryCache = new Map<string, string>();
  private tagLookupDisabled = false;

  constructor(options: SourceHttpOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.apiKey = options.apiKey?.trim() || undefined;
    this.userId = options.userId?.trim() || undefined;
    this.knownCategories = options.tagCategories ?? (() => new Map());
  }

  async fetchPage(request: SourcePageRequest): Promise<SourcePage> {
    const limit = Math.min(Math.max(1, Math.floor(request.limit)), MAX_PAGE_SIZE);
    const cursor = request.cursor && /^\d+$/.test(request.cursor) ? Number(request.cursor) : null;
    const since = request.since && /^\d+$/.test(request.since) ? Number(request.since) : null;
    // Gelbooru pages are 0-based and newest-first, and its search syntax has no
    // id range, so the archive walk is `pid`-based and head polling simply
    // re-reads the newest pages until it runs into the watermark again.
    const pid = cursor ?? Math.max(1, Math.floor(request.page)) - 1;

    const url = this.postUrl({ pid, limit, tags: request.tags?.trim() ?? '' });
    const response = await this.request(url, request.signal);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new SourceError('gelbooru returned invalid JSON', response.status);
    }

    const items = gelbooruItems(data);
    const parsed = items
      .map((item) => parseGelbooruPost(item, { baseUrl: this.baseUrl }))
      .filter((post): post is SourcePost => post !== null);

    await this.resolveCategories(
      parsed.flatMap((post) => post.tags),
      request.signal,
    );
    const posts = items
      .map((item) =>
        parseGelbooruPost(item, {
          baseUrl: this.baseUrl,
          categoryOf: (name) => this.categoryOf(name),
        }),
      )
      .filter((post): post is SourcePost => post !== null)
      .filter((post) => since === null || Number(post.originId) > since);

    // Use every raw item, not only the mapped ones: a page of filtered posts
    // (AI/3D) still crosses the watermark and must stop head polling.
    const rawIds = items
      .map((item) => positiveNumber(asRecord(item)?.id))
      .filter((id): id is number => id !== undefined);
    const hitWatermark = since !== null && rawIds.some((id) => id <= since);
    const hasMore = items.length >= limit && !hitWatermark;

    return {
      posts,
      hasMore,
      // `since` polling advances by page number; a cursor would pin it to one page.
      ...(since === null && hasMore ? { cursor: String(pid + 1) } : {}),
    };
  }

  private categoryOf(name: string): string | undefined {
    return this.categoryCache.get(name);
  }

  private async resolveCategories(names: string[], signal?: AbortSignal): Promise<void> {
    if (this.tagLookupDisabled) return;
    const unique = [...new Set(names)].filter((name) => !this.categoryCache.has(name));
    if (unique.length === 0) return;

    // Reuse what earlier imports and uploads already stored in `tags`.
    for (const [name, category] of this.knownCategories(unique)) {
      this.categoryCache.set(name, category);
    }
    const missing = unique.filter((name) => !this.categoryCache.has(name));

    for (let index = 0; index < missing.length; index += TAG_BATCH_SIZE) {
      if (this.tagLookupDisabled) return;
      const batch = missing.slice(index, index + TAG_BATCH_SIZE);
      const url = this.tagUrl(batch);
      let rows: unknown[];
      try {
        const response = await this.request(url, signal);
        rows = gelbooruItems(await response.json());
      } catch {
        // Categories are cosmetic: keep the run going with `general` tags.
        this.tagLookupDisabled = true;
        return;
      }

      const requested = new Set(batch);
      let matched = 0;
      for (const row of rows) {
        const record = asRecord(row);
        const name = typeof record?.name === 'string' ? record.name.trim().toLowerCase() : '';
        if (!requested.has(name)) continue;
        matched += 1;
        this.categoryCache.set(name, TAG_TYPE_CATEGORIES[String(record?.type)] ?? 'general');
      }
      if (matched === 0) {
        // The endpoint ignored `names`; stop asking rather than guess wrongly.
        this.tagLookupDisabled = true;
        return;
      }
      if (index + TAG_BATCH_SIZE < missing.length) await this.sleep(TAG_BATCH_PAUSE_MS);
    }
  }

  private postUrl(input: { pid: number; limit: number; tags: string }): URL {
    const url = new URL('/index.php', this.baseUrl);
    url.searchParams.set('page', 'dapi');
    url.searchParams.set('s', 'post');
    url.searchParams.set('q', 'index');
    url.searchParams.set('json', '1');
    url.searchParams.set('limit', String(input.limit));
    url.searchParams.set('pid', String(input.pid));
    if (input.tags) url.searchParams.set('tags', input.tags);
    this.auth(url);
    return url;
  }

  private tagUrl(names: string[]): URL {
    const url = new URL('/index.php', this.baseUrl);
    url.searchParams.set('page', 'dapi');
    url.searchParams.set('s', 'tag');
    url.searchParams.set('q', 'index');
    url.searchParams.set('json', '1');
    url.searchParams.set('limit', String(TAG_BATCH_SIZE));
    url.searchParams.set('names', names.join(' '));
    this.auth(url);
    return url;
  }

  private auth(url: URL): void {
    if (!this.apiKey || !this.userId) return;
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('user_id', this.userId);
  }

  private async request(url: URL, signal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            accept: 'application/json',
            'user-agent': this.userAgent,
          },
          signal,
        });

        if (response.status === 429 || response.status >= 500) {
          if (attempt === this.maxRetries) {
            await response.body?.cancel().catch(() => undefined);
            throw new SourceError(`gelbooru returned HTTP ${response.status}`, response.status);
          }
          await response.body?.cancel().catch(() => undefined);
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : 1000 * 2 ** attempt;
          await this.sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 401) {
            throw new SourceError(
              'gelbooru requires credentials: set GELBOORU_API_KEY and GELBOORU_USER_ID',
              401,
            );
          }
          throw new SourceError(`gelbooru returned HTTP ${response.status}`, response.status);
        }
        return response;
      } catch (error) {
        if (error instanceof SourceError || signal?.aborted) throw error;
        lastError = error;
        if (attempt < this.maxRetries) await this.sleep(1000 * 2 ** attempt);
      }
    }
    throw new SourceError(
      lastError instanceof Error
        ? `gelbooru request failed: ${lastError.message}`
        : 'gelbooru request failed',
    );
  }
}
