import {
  absoluteHttpUrl,
  asRecord,
  IMAGE_EXTENSIONS,
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

const DEFAULT_BASE_URL = 'https://danbooru.donmai.us';
const DEFAULT_USER_AGENT = 'BoorushikoBot/0.1 (booru importer)';
const MAX_PAGE_SIZE = 200;
const MAX_RETRIES = 3;

const TAG_FIELDS: Array<[category: string, field: string]> = [
  ['general', 'tag_string_general'],
  ['artist', 'tag_string_artist'],
  ['character', 'tag_string_character'],
  ['copyright', 'tag_string_copyright'],
  ['meta', 'tag_string_meta'],
];

interface DanbooruVariant {
  type?: unknown;
  url?: unknown;
}

interface DanbooruRawPost {
  id?: unknown;
  rating?: unknown;
  file_ext?: unknown;
  file_url?: unknown;
  source?: unknown;
  preview_file_url?: unknown;
  large_file_url?: unknown;
  image_width?: unknown;
  image_height?: unknown;
  file_size?: unknown;
  tag_string_artist?: unknown;
  tag_string_character?: unknown;
  tag_string_copyright?: unknown;
  tag_string_general?: unknown;
  tag_string_meta?: unknown;
  is_pending?: unknown;
  is_flagged?: unknown;
  is_deleted?: unknown;
  is_banned?: unknown;
  media_asset?: { variants?: unknown } | null;
}

function variantUrl(raw: DanbooruRawPost, baseUrl: string): string | null {
  const asset = raw.media_asset;
  if (!asset || !Array.isArray(asset.variants)) return null;
  const variants = asset.variants as DanbooruVariant[];
  for (const type of ['720x720', '360x360', '180x180', 'sample']) {
    const variant = variants.find((item) => item?.type === type);
    const url = absoluteHttpUrl(variant?.url, baseUrl);
    if (url) return url;
  }
  return null;
}

/** Map one Danbooru API item to the engine's source format. */
export function parseDanbooruPost(value: unknown, baseUrl = DEFAULT_BASE_URL): SourcePost | null {
  const raw = asRecord(value) as DanbooruRawPost | null;
  if (!raw) return null;

  const id = positiveNumber(raw.id);
  if (!id) return null;
  if (raw.is_pending || raw.is_flagged || raw.is_deleted || raw.is_banned) return null;

  const ext = typeof raw.file_ext === 'string' ? raw.file_ext.toLowerCase() : '';
  const mime = IMAGE_EXTENSIONS[ext];
  if (!mime) return null;

  const fileUrl = absoluteHttpUrl(raw.file_url, baseUrl);
  if (!fileUrl) return null;

  const rating = normalizeRating(raw.rating);
  if (!rating) return null;

  // The same name can appear in more than one category field. Keep one tag,
  // preferring a specific category over `general`, or the post count would be
  // incremented twice for the same row.
  const byName = new Map<string, { category: string; name: string }>();
  for (const [category, field] of TAG_FIELDS) {
    for (const name of splitTags(raw[field as keyof DanbooruRawPost])) {
      const existing = byName.get(name);
      if (!existing || existing.category === 'general') byName.set(name, { category, name });
    }
  }
  const tags = [...byName.values()].map(({ category, name }) =>
    category === 'general' ? name : `${category}:${name}`,
  );
  if (isBlockedTags(tags)) return null;

  // 720x720 stays under ~50 KB and is sharp on retina; the default preview is only 180px.
  const previewUrl =
    variantUrl(raw, baseUrl) ??
    absoluteHttpUrl(raw.preview_file_url, baseUrl) ??
    absoluteHttpUrl(raw.large_file_url, baseUrl);

  const artistSource = sourceUrl(raw.source);

  return {
    provider: 'danbooru',
    originId: String(id),
    pageUrl: new URL(`/posts/${id}`, baseUrl).toString(),
    fileUrl,
    ...(artistSource ? { sourceUrl: artistSource } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    mime,
    rating,
    tags,
    ...(positiveNumber(raw.image_width) ? { width: positiveNumber(raw.image_width) } : {}),
    ...(positiveNumber(raw.image_height) ? { height: positiveNumber(raw.image_height) } : {}),
    ...(positiveNumber(raw.file_size) ? { bytes: positiveNumber(raw.file_size) } : {}),
  };
}

export class DanbooruSource implements BooruSource {
  readonly name = 'danbooru';

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SourceHttpOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async fetchPage(request: SourcePageRequest): Promise<SourcePage> {
    const page = Math.max(1, Math.floor(request.page));
    const limit = Math.min(Math.max(1, Math.floor(request.limit)), MAX_PAGE_SIZE);
    const requestedTags = request.tags?.trim() ?? '';
    const cursor = request.cursor && /^\d+$/.test(request.cursor) ? Number(request.cursor) : null;
    const since = request.since && /^\d+$/.test(request.since) ? Number(request.since) : null;
    // Offset pagination drifts when new posts arrive between requests. Once the
    // first page is read, continue below the oldest id instead. Do not add a
    // rating filter here: an empty query means all ratings, and tags such as
    // `rating:e` or `rating:g,q` are an explicit caller choice.
    // Incremental polling uses `id:>head order:id` so the oldest unseen post is
    // returned first; a slow import therefore cannot skip a gap of new posts.
    const range = since
      ? cursor
        ? `id:>${since} id:<${cursor}`
        : `id:>${since}`
      : cursor
        ? `id:<${cursor}`
        : '';
    const tags = [requestedTags, range, since ? 'order:id' : ''].filter(Boolean).join(' ');

    const url = new URL('/posts.json', this.baseUrl);
    if (tags) url.searchParams.set('tags', tags);
    // A cursor always starts at page 1; `since` polling may use page 2, 3, ...
    // while it walks forward through new posts.
    url.searchParams.set('page', String(cursor ? 1 : page));
    url.searchParams.set('limit', String(limit));

    const response = await this.request(url, request.signal);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new SourceError('danbooru returned invalid JSON', response.status);
    }
    if (!Array.isArray(data)) {
      throw new SourceError('danbooru returned an unexpected response');
    }

    const items = data as unknown[];
    const posts = items
      .map((item) => parseDanbooruPost(item, this.baseUrl))
      .filter((post): post is SourcePost => post !== null);
    const ids = items
      .map((item) => positiveNumber(asRecord(item)?.id))
      .filter((id): id is number => id !== undefined);
    // In `since` mode pagination moves forward by page number; returning the
    // minimum id would make the importer jump backwards and skip new posts.
    const nextCursor = !since && ids.length > 0 ? String(Math.min(...ids)) : undefined;

    return {
      posts,
      hasMore: data.length >= limit,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
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
            throw new SourceError(`danbooru returned HTTP ${response.status}`, response.status);
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
          throw new SourceError(`danbooru returned HTTP ${response.status}`, response.status);
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
        ? `danbooru request failed: ${lastError.message}`
        : 'danbooru request failed',
    );
  }
}
