import { createHash } from 'node:crypto';
import type { EngineContext } from './context.js';
import { findDnpMatch } from './policy.js';
import { parseTags } from './upload.js';

/**
 * Remote posts never copy the file: the parser stores direct URLs and the image
 * stays on the source. We therefore have no real content hash, so the unique
 * `md5` column holds a deterministic hash of the source identity. That keeps
 * parser retries idempotent without downloading a multi-megabyte original.
 */

const IMAGE_TYPES: Record<string, { mime: string; ext: string }> = {
  'image/png': { mime: 'image/png', ext: 'png' },
  'image/jpeg': { mime: 'image/jpeg', ext: 'jpg' },
  'image/jpg': { mime: 'image/jpeg', ext: 'jpg' },
  'image/webp': { mime: 'image/webp', ext: 'webp' },
  'image/gif': { mime: 'image/gif', ext: 'gif' },
  'image/avif': { mime: 'image/avif', ext: 'avif' },
};

const REFERER_POLICIES = new Set(['none', 'page', 'origin']);

export type RemotePostInput = {
  provider?: unknown;
  originId?: unknown;
  pageUrl?: unknown;
  fileUrl?: unknown;
  sourceUrl?: unknown;
  previewUrl?: unknown;
  refererPolicy?: unknown;
  rating?: unknown;
  tags?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  bytes?: unknown;
};

export interface CreateRemotePostResult {
  postId: number;
  duplicate: boolean;
  status: 'active';
}

export class RemotePostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemotePostError';
    this.code = code;
  }
}

function text(value: unknown, field: string, max = 2048): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new RemotePostError('invalid_' + field, `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new RemotePostError('invalid_' + field, `${field} is longer than ${max} characters`);
  }
  return trimmed;
}

function httpUrl(value: unknown, field: string, required: boolean): string | null {
  const raw = text(value, field);
  if (!raw) {
    if (required) throw new RemotePostError('invalid_' + field, `${field} is required`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemotePostError('invalid_' + field, `${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemotePostError('invalid_' + field, `${field} must use http or https`);
  }
  if (url.username || url.password) {
    throw new RemotePostError('invalid_' + field, `${field} must not contain credentials`);
  }
  if (!url.hostname) {
    throw new RemotePostError('invalid_' + field, `${field} has no host`);
  }
  return url.toString();
}

function tagInput(value: unknown): string | string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as string[];
  }
  throw new RemotePostError('invalid_tags', 'tags must be a string or an array of strings');
}

function optionalSize(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RemotePostError('invalid_' + field, `${field} must be a non-negative integer`);
  }
  return parsed;
}

export function normalizeRemoteMime(value: unknown): { mime: string; ext: string } {
  const raw = text(value, 'mime', 100);
  if (!raw) throw new RemotePostError('invalid_mime', 'mime is required');
  const type = IMAGE_TYPES[raw.toLowerCase()];
  if (!type) {
    throw new RemotePostError(
      'unsupported_media',
      'only png, jpeg, webp, gif and avif images are supported for remote posts',
    );
  }
  return type;
}

/** Stable identity for a parser item: provider id when available, file URL otherwise. */
export function remoteIdentity(provider: string, originId: string | null, fileUrl: string): string {
  return `boorushiko:remote:${provider}:${originId ?? fileUrl}`;
}

export function createRemotePost(
  ctx: EngineContext,
  input: RemotePostInput,
): CreateRemotePostResult {
  const provider = (text(input.provider, 'provider', 40) ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(provider)) {
    throw new RemotePostError('invalid_provider', 'provider must be a short lowercase slug');
  }

  const fileUrl = httpUrl(input.fileUrl, 'fileUrl', true)!;
  const pageUrl = httpUrl(input.pageUrl, 'pageUrl', false);
  const sourceUrl = httpUrl(input.sourceUrl, 'sourceUrl', false);
  const previewUrl = httpUrl(input.previewUrl, 'previewUrl', false);
  const originId = text(input.originId, 'originId', 200);

  const rating = (text(input.rating, 'rating', 10) ?? 's').toLowerCase();
  if (rating !== 's' && rating !== 'q' && rating !== 'e') {
    throw new RemotePostError('invalid_rating', 'rating must be s, q or e');
  }

  const media = normalizeRemoteMime(input.mime);
  const width = optionalSize(input.width, 'width');
  const height = optionalSize(input.height, 'height');
  const bytes = optionalSize(input.bytes, 'bytes');
  const policy = (text(input.refererPolicy, 'refererPolicy', 20) ?? 'none').toLowerCase();
  if (!REFERER_POLICIES.has(policy)) {
    throw new RemotePostError('invalid_referer', 'refererPolicy must be none, page or origin');
  }

  const parsedTags = parseTags(tagInput(input.tags));
  const dnp = findDnpMatch(ctx.sqlite, parsedTags, sourceUrl);
  if (dnp) {
    throw new RemotePostError('dnp_artist', `artist is on the do-not-post list: ${dnp.name}`);
  }

  const identity = remoteIdentity(provider, originId, fileUrl);
  const md5 = createHash('md5').update(identity).digest('hex');
  const sha256 = createHash('sha256').update(identity).digest('hex');
  const now = new Date().toISOString();

  const run = ctx.sqlite.transaction((): CreateRemotePostResult => {
    const existing = ctx.sqlite.prepare('SELECT id FROM posts WHERE md5 = ?').get(md5) as
      { id: number } | undefined;
    if (existing) {
      // Re-imports are also the cheapest way to refresh a preview URL (for
      // example, Danbooru's 180px preview -> its 720px media variant).
      if (previewUrl) {
        ctx.sqlite
          .prepare('UPDATE post_origins SET preview_url = ? WHERE post_id = ? AND provider = ?')
          .run(previewUrl, existing.id, provider);
      }
      if (sourceUrl) {
        ctx.sqlite
          .prepare('UPDATE posts SET source_url = ?, updated_at = ? WHERE id = ?')
          .run(sourceUrl, now, existing.id);
      }
      return { postId: existing.id, duplicate: true, status: 'active' };
    }

    const inserted = ctx.sqlite
      .prepare(
        `INSERT INTO posts
          (storage_kind, md5, sha256, mime, ext, width, height, bytes, rating, source_url,
           status, created_at, updated_at)
         VALUES ('remote', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(md5, sha256, media.mime, media.ext, width, height, bytes, rating, sourceUrl, now, now);
    const postId = Number(inserted.lastInsertRowid);

    ctx.sqlite
      .prepare(
        `INSERT INTO post_origins
          (post_id, provider, page_url, file_url, preview_url, referer_policy, status, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)`,
      )
      .run(postId, provider, pageUrl, fileUrl, previewUrl, policy, now);

    const upsertTag = ctx.sqlite.prepare(
      `INSERT INTO tags (name, category, post_count) VALUES (?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET post_count = post_count + 1
       RETURNING id`,
    );
    const linkTag = ctx.sqlite.prepare(
      'INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)',
    );
    for (const tag of parsedTags) {
      const row = upsertTag.get(tag.name, tag.category) as { id: number };
      linkTag.run(postId, row.id);
    }

    return { postId, duplicate: false, status: 'active' };
  });

  return run();
}
