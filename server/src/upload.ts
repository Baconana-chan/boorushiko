import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { EngineContext } from './context.js';
import { enqueueJob, type MirrorUploadPayload } from './jobs.js';
import { makeThumb, readHead, readImageDimensions, sniffMedia, type MediaInfo } from './media.js';
import { detectPolicyFlags, DnpArtistError, findDnpMatch } from './policy.js';
import { posts } from './schema.js';
import type { Rating } from './search.js';

export class UploadTooLargeError extends Error {}
export class UnsupportedMediaError extends Error {}

export interface StagedFile {
  path: string;
  bytes: number;
  md5: string;
  sha256: string;
  head: Buffer;
}

export interface StageOptions {
  dir: string;
  maxBytes: number;
}

export async function stageStream(
  source: NodeJS.ReadableStream,
  options: StageOptions,
): Promise<StagedFile> {
  await fs.mkdir(options.dir, { recursive: true });
  const partial = join(options.dir, `.part-${randomUUID()}`);

  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let bytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        callback(new UploadTooLargeError(`file exceeds ${options.maxBytes} bytes`));
        return;
      }
      md5.update(chunk);
      sha256.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, meter, createWriteStream(partial));
  } catch (error) {
    await fs.unlink(partial).catch(() => undefined);
    throw error;
  }

  const finalPath = join(options.dir, randomUUID());
  await fs.rename(partial, finalPath);

  return {
    path: finalPath,
    bytes,
    md5: md5.digest('hex'),
    sha256: sha256.digest('hex'),
    head: await readHead(finalPath, 64),
  };
}

export function stageBuffer(buffer: Buffer, options: StageOptions): Promise<StagedFile> {
  return stageStream(Readable.from([buffer]), options);
}

export interface CreatePostInput {
  tags?: string | string[];
  rating?: string;
  sourceUrl?: string;
  filename?: string;
  uploadedBy?: number | null;
}

export interface CreatePostResult {
  postId: number;
  duplicate: boolean;
  status: string;
  thumbPath?: string;
  jobs: number;
}

const TAG_CATEGORIES = new Set(['general', 'artist', 'character', 'copyright', 'species', 'meta']);

export function parseTags(input: string | string[] | undefined): Array<{
  name: string;
  category: string;
}> {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : input.split(/[,\s]+/);
  const seen = new Set<string>();
  const result: Array<{ name: string; category: string }> = [];

  for (const entry of raw) {
    let token = entry.trim().toLowerCase().replace(/\s+/g, '_');
    if (!token) continue;
    let category = 'general';
    const prefixed = /^([a-z_]+):(.+)$/.exec(token);
    if (prefixed && TAG_CATEGORIES.has(prefixed[1]!)) {
      category = prefixed[1]!;
      token = prefixed[2]!;
    }
    if (!token || token.length > 100 || seen.has(token)) continue;
    seen.add(token);
    result.push({ name: token, category });
  }
  return result;
}

async function discard(path: string): Promise<void> {
  await fs.unlink(path).catch(() => undefined);
}

export async function createPostFromStaged(
  ctx: EngineContext,
  staged: StagedFile,
  input: CreatePostInput = {},
): Promise<CreatePostResult> {
  const media: MediaInfo | null = sniffMedia(staged.head);
  if (!media) {
    await discard(staged.path);
    throw new UnsupportedMediaError('unsupported file type');
  }

  const parsedTags = parseTags(input.tags);
  const dnp = findDnpMatch(ctx.sqlite, parsedTags, input.sourceUrl);
  if (dnp) {
    await discard(staged.path);
    throw new DnpArtistError(dnp.name);
  }

  const existing = ctx.sqlite.prepare('SELECT id FROM posts WHERE md5 = ?').get(staged.md5) as
    { id: number } | undefined;
  if (existing) {
    await discard(staged.path);
    return { postId: existing.id, duplicate: true, status: 'active', jobs: 0 };
  }

  let width = 0;
  let height = 0;
  let thumbPath: string | undefined;
  let policyFlags: string[] = [];

  if (media.kind === 'image') {
    try {
      const dimensions = await readImageDimensions(staged.path);
      width = dimensions.width;
      height = dimensions.height;
      policyFlags = await detectPolicyFlags(staged.path, input.filename);
      thumbPath = `${staged.path}.thumb.webp`;
      await makeThumb(staged.path, thumbPath);
    } catch (error) {
      await discard(staged.path);
      throw new UnsupportedMediaError(
        error instanceof Error ? `cannot read image: ${error.message}` : 'cannot read image',
      );
    }
  }

  const rating = (input.rating ?? 's').toLowerCase();
  if (rating !== 's' && rating !== 'q' && rating !== 'e') {
    await discard(staged.path);
    if (thumbPath) await discard(thumbPath);
    throw new Error(`invalid rating: ${rating}`);
  }

  const now = new Date().toISOString();
  const inserted = ctx.db
    .insert(posts)
    .values({
      storageKind: 'hosted',
      md5: staged.md5,
      sha256: staged.sha256,
      mime: media.mime,
      ext: media.ext,
      width,
      height,
      bytes: staged.bytes,
      rating,
      sourceUrl: input.sourceUrl ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const postId = Number(inserted.lastInsertRowid);

  ctx.sqlite
    .prepare('UPDATE posts SET uploaded_by = ?, policy_flags = ? WHERE id = ?')
    .run(input.uploadedBy ?? null, JSON.stringify(policyFlags), postId);

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

  let jobs = 0;
  for (const mirror of ctx.mirrors.values()) {
    if (!mirror.accepts(media.mime)) continue;
    if (staged.bytes > mirror.maxBytes) continue;
    const payload: MirrorUploadPayload = {
      postId,
      host: mirror.name,
      deliveryPath: staged.path,
      thumbPath,
      mime: media.mime,
      bytes: staged.bytes,
      filename: `post-${postId}.${media.ext}`,
    };
    enqueueJob(ctx.sqlite, 'mirror_upload', payload);
    jobs += 1;
  }

  return {
    postId,
    duplicate: false,
    status: 'pending',
    thumbPath,
    jobs,
  };
}
