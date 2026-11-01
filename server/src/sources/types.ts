import type { Rating } from '../search.js';

export interface SourcePost {
  provider: string;
  originId: string;
  pageUrl: string;
  fileUrl: string;
  /** Original artist page when the source API exposes one (Danbooru `source`). */
  sourceUrl?: string;
  previewUrl?: string;
  mime: string;
  rating: Rating;
  tags: string[];
  width?: number;
  height?: number;
  bytes?: number;
}

export interface SourcePageRequest {
  page: number;
  limit: number;
  tags?: string;
  /** Stable pagination cursor returned by the previous page, when supported. */
  cursor?: string;
  /** Import only posts newer than this id, oldest first (incremental polling). */
  since?: string;
  signal?: AbortSignal;
}

export interface SourcePage {
  posts: SourcePost[];
  hasMore: boolean;
  /** Use this on the next request instead of relying on offset pagination. */
  cursor?: string;
}

export interface BooruSource {
  readonly name: string;
  fetchPage(request: SourcePageRequest): Promise<SourcePage>;
}

export interface SourceHttpOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Account credentials for hosts that gate their API (Gelbooru). */
  apiKey?: string;
  userId?: string;
  /**
   * Looks up tag categories we already know (from the local `tags` table), so
   * a source without category data does not ask the remote API for every tag.
   */
  tagCategories?: (names: string[]) => Map<string, string>;
}

export class SourceError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
  }
}
