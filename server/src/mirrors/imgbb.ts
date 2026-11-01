import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MirrorHost, UploadInput, UploadResult } from './types.js';

interface ImgbbResponse {
  success?: boolean;
  data?: { url?: string; id?: string; display_url?: string };
  error?: { message?: string };
}

/**
 * imgbb: 32 MB, images only, API key required. Direct links look like i.ibb.co/xxxx/file.png.
 * Their ToS forbids automated use; treat this mirror as replaceable (see TODO §1).
 */
export function createImgbbMirror(apiKey: string): MirrorHost {
  return {
    name: 'imgbb',
    maxBytes: 32 * 1024 * 1024,
    accepts(mime: string): boolean {
      return mime.startsWith('image/');
    },
    async upload(input: UploadInput): Promise<UploadResult> {
      const body = await readFile(input.path);
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(body)], { type: input.mime }), basename(input.path));

      const response = await fetch(
        `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`,
        { method: 'POST', body: form },
      );
      const json = (await response.json()) as ImgbbResponse;
      const url = json.data?.url ?? json.data?.display_url;
      if (!response.ok || !json.success || !url) {
        throw new Error(`imgbb: ${response.status} ${json.error?.message ?? 'upload failed'}`);
      }
      return { url, remoteId: json.data?.id };
    },
  };
}
