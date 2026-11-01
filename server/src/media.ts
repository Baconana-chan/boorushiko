import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

export type MediaKind = 'image' | 'video';

export interface MediaInfo {
  mime: string;
  ext: string;
  kind: MediaKind;
}

const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash']);

export function sniffMedia(head: Buffer): MediaInfo | null {
  if (head.length < 12) return null;

  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  }
  const ascii = head.subarray(0, 16).toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  }
  if (ascii.startsWith('RIFF') && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  }

  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') {
      return { mime: 'image/avif', ext: 'avif', kind: 'image' };
    }
    if (MP4_BRANDS.has(brand)) {
      return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    }
  }

  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // Matroska and WebM share the EBML header; only accept the WebM DocType.
    const probe = head.subarray(0, 64).toString('latin1');
    if (probe.includes('webm')) {
      return { mime: 'video/webm', ext: 'webm', kind: 'video' };
    }
  }

  return null;
}

export async function readHead(path: string, length = 64): Promise<Buffer> {
  const buffer = await readFile(path);
  return buffer.subarray(0, Math.min(length, buffer.length));
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function readImageDimensions(path: string): Promise<ImageDimensions> {
  const meta = await sharp(path).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('could not read image dimensions');
  }
  return { width: meta.width, height: meta.height };
}

export interface ThumbResult extends ImageDimensions {
  bytes: number;
}

/**
 * Renders a 300px WebP preview (retina-safe for a 150–250px grid).
 * Encodes to a buffer and writes it with fs: on Windows libvips keeps a handle
 * on files written via .toFile(), which makes the later cleanup fail with EBUSY.
 */
export async function makeThumb(inputPath: string, outputPath: string): Promise<ThumbResult> {
  const buffer = await sharp(inputPath)
    .rotate()
    .resize({ width: 300, height: 300, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  await writeFile(outputPath, buffer);
  const meta = await sharp(buffer).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes: buffer.length,
  };
}
