import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processJobs } from '../src/jobs.js';
import {
  createPostFromStaged,
  parseTags,
  stageBuffer,
  UnsupportedMediaError,
} from '../src/upload.js';
import { createTestContext } from './helpers.js';

function stageOptions(ctx: ReturnType<typeof createTestContext>['ctx']) {
  return { dir: ctx.config.stagingDir, maxBytes: ctx.config.maxUploadBytes };
}

async function samplePng(width = 1200, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#2b6cb0' } })
    .png()
    .toBuffer();
}

describe('upload pipeline', () => {
  it('stages, makes a 300px preview and activates the post after mirroring', async () => {
    const { ctx, uploaded } = createTestContext();
    const png = await samplePng();

    const staged = await stageBuffer(png, stageOptions(ctx));
    expect(staged.bytes).toBe(png.length);
    expect(staged.md5).toHaveLength(32);
    expect(staged.sha256).toHaveLength(64);

    const result = await createPostFromStaged(ctx, staged, {
      tags: 'artist:someone, flandre, solo',
      rating: 's',
    });
    expect(result.duplicate).toBe(false);
    expect(result.jobs).toBe(1);
    expect(existsSync(result.thumbPath!)).toBe(true);

    const thumb = await sharp(await readFile(result.thumbPath!)).metadata();
    expect(thumb.width).toBe(300);
    expect(thumb.height).toBe(225);
    expect(thumb.format).toBe('webp');

    await processJobs(ctx);

    const post = ctx.sqlite
      .prepare('SELECT status, width, height, mime FROM posts WHERE id = ?')
      .get(result.postId) as { status: string; width: number; height: number; mime: string };
    expect(post).toMatchObject({ status: 'active', width: 1200, height: 900, mime: 'image/png' });

    const tagRows = ctx.sqlite
      .prepare(
        `SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id = ? ORDER BY t.name`,
      )
      .all(result.postId) as Array<{ name: string }>;
    expect(tagRows.map((row) => row.name)).toEqual(['flandre', 'solo', 'someone']);

    const variant = ctx.sqlite
      .prepare(`SELECT url FROM post_variants WHERE post_id = ? AND kind = 'thumb300'`)
      .get(result.postId) as { url: string };
    expect(variant.url).toMatch(/^https:\/\/fake\.local\//);

    expect(uploaded).toHaveLength(2); // delivery + thumbnail
    expect(existsSync(staged.path)).toBe(false); // staging is cleaned once mirrored
    expect(existsSync(result.thumbPath!)).toBe(false);
  });

  it('detects duplicates by md5 and discards the new staged file', async () => {
    const { ctx } = createTestContext();
    const png = await samplePng();

    const first = await createPostFromStaged(ctx, await stageBuffer(png, stageOptions(ctx)));
    const staged = await stageBuffer(png, stageOptions(ctx));
    const second = await createPostFromStaged(ctx, staged);

    expect(second.duplicate).toBe(true);
    expect(second.postId).toBe(first.postId);
    expect(existsSync(staged.path)).toBe(false);
  });

  it('rejects unsupported bytes and removes the staged file', async () => {
    const { ctx } = createTestContext();
    const staged = await stageBuffer(Buffer.from('definitely not an image'), stageOptions(ctx));

    await expect(createPostFromStaged(ctx, staged)).rejects.toBeInstanceOf(UnsupportedMediaError);
    expect(existsSync(staged.path)).toBe(false);
  });

  it('stops streaming when the size limit is exceeded', async () => {
    const { ctx } = createTestContext({ maxUploadBytes: 16 });
    await expect(
      stageBuffer(Buffer.alloc(64), { dir: ctx.config.stagingDir, maxBytes: 16 }),
    ).rejects.toThrow(/exceeds/);
  });

  it('parses tag categories from the upload form', () => {
    expect(parseTags('artist:foo bar,character:baz')).toEqual([
      { name: 'foo', category: 'artist' },
      { name: 'bar', category: 'general' },
      { name: 'baz', category: 'character' },
    ]);

    expect(
      parseTags(
        'copyright:touhou character:reimu artist:zun species:youkai meta:highres general:solo',
      ),
    ).toEqual([
      { name: 'touhou', category: 'copyright' },
      { name: 'reimu', category: 'character' },
      { name: 'zun', category: 'artist' },
      { name: 'youkai', category: 'species' },
      { name: 'highres', category: 'meta' },
      { name: 'solo', category: 'general' },
    ]);
  });
});
