import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MirrorHost, UploadInput, UploadResult } from './types.js';

const ENDPOINT = 'https://catbox.moe/user/api.php';

/**
 * Catbox has no formal API documentation — only the tools page
 * (https://catbox.moe/tools.php) and community examples. This adapter uses the
 * form endpoint behind that page: `reqtype=fileupload` + `fileToUpload`.
 * It allows 200 MB uploads and direct hotlinks, but forbids commercial use and
 * hotlinking from ad-supported sites; Boorushiko is ad-free, so it fits.
 */
export function createCatboxMirror(): MirrorHost {
  return {
    name: 'catbox',
    maxBytes: 200 * 1024 * 1024,
    accepts(mime: string): boolean {
      return mime.startsWith('image/') || mime === 'video/mp4' || mime === 'video/webm';
    },
    async upload(input: UploadInput): Promise<UploadResult> {
      const body = await readFile(input.path);
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append(
        'fileToUpload',
        new Blob([new Uint8Array(body)], { type: input.mime }),
        input.filename || basename(input.path),
      );

      const response = await fetch(ENDPOINT, { method: 'POST', body: form });
      const text = (await response.text()).trim();
      if (!response.ok || !/^https:\/\//.test(text)) {
        throw new Error(`catbox: ${response.status} ${text.slice(0, 200)}`);
      }
      return { url: text };
    },
  };
}

export async function assertReadableFile(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`not a file: ${path}`);
  return info.size;
}
