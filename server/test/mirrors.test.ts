import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createYourImageShareMirror,
  YOURIMAGESHARE_MAX_BYTES,
} from '../src/mirrors/yourimageshare.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleFile(): { path: string; bytes: number } {
  const dir = mkdtempSync(join(tmpdir(), 'boorushiko-yis-'));
  dirs.push(dir);
  const path = join(dir, 'art.webp');
  const body = Buffer.from('RIFF....WEBP');
  writeFileSync(path, body);
  return { path, bytes: body.length };
}

function successBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'success',
    msg: 'success',
    data: {
      id: 'aB3xY9qRz1',
      type: 'image',
      path: 'https://i.yourimageshare.com/aB3xY9qRz1.png',
      src: 'https://yourimageshare.com/ib/aB3xY9qRz1.webp',
      ...extra,
    },
  });
}

describe('yourimageshare mirror', () => {
  it('sends the documented multipart request and uses the permanent src link', async () => {
    const { path, bytes } = sampleFile();
    let seen: { url: string; init: RequestInit } | null = null;
    const mirror = createYourImageShareMirror('secret-key', async (url, init) => {
      seen = { url, init };
      return new Response(successBody(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    expect(mirror.maxBytes).toBe(YOURIMAGESHARE_MAX_BYTES);
    expect(mirror.accepts('image/gif')).toBe(true);
    expect(mirror.accepts('video/webm')).toBe(true);
    expect(mirror.accepts('video/quicktime')).toBe(false);

    const result = await mirror.upload({
      path,
      filename: 'art.webp',
      mime: 'image/webp',
      bytes,
    });

    expect(result).toEqual({
      url: 'https://yourimageshare.com/ib/aB3xY9qRz1.webp',
      remoteId: 'aB3xY9qRz1',
    });
    expect(seen!.url).toBe('https://yourimageshare.com/api');
    expect((seen!.init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key');
    expect(seen!.init.method).toBe('POST');

    const form = seen!.init.body as FormData;
    expect(form.get('visibility')).toBe('unlisted');
    const file = form.get('uploads') as File;
    expect(file.name).toBe('art.webp');
    expect(file.type).toBe('image/webp');
    expect(file.size).toBe(bytes);
  });

  it('surfaces documented JSON errors instead of a silent failure', async () => {
    const { path, bytes } = sampleFile();
    const mirror = createYourImageShareMirror(
      'key',
      async () =>
        new Response(JSON.stringify({ type: 'error', errors: 'Unsupported file type.' }), {
          status: 422,
        }),
    );

    await expect(
      mirror.upload({ path, filename: 'art.webp', mime: 'image/webp', bytes }),
    ).rejects.toThrow('yourimageshare: 422 Unsupported file type.');
  });

  it('never falls back to path when src is missing', async () => {
    const { path, bytes } = sampleFile();
    const mirror = createYourImageShareMirror(
      'key',
      async () =>
        new Response(JSON.stringify({ type: 'success', data: { id: 'x', path: 'https://x/y' } }), {
          status: 200,
        }),
    );

    await expect(
      mirror.upload({ path, filename: 'art.webp', mime: 'image/webp', bytes }),
    ).rejects.toThrow(/yourimageshare: 200/);
  });

  it('keeps an HTML proxy error readable', async () => {
    const { path, bytes } = sampleFile();
    const mirror = createYourImageShareMirror(
      'key',
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
    );

    await expect(
      mirror.upload({ path, filename: 'art.webp', mime: 'image/webp', bytes }),
    ).rejects.toThrow(/yourimageshare: 502 <html>bad gateway/);
  });
});
