import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MirrorHost, UploadInput, UploadResult } from './types.js';

const ENDPOINT = 'https://yourimageshare.com/api';

/** One direct POST is capped at 100 MB; larger files need `POST /api/chunk`. */
export const YOURIMAGESHARE_MAX_BYTES = 100 * 1024 * 1024;

interface YourImageShareResponse {
  type?: string;
  errors?: string;
  data?: {
    id?: string;
    /** Permanent direct link; `path` changes when the file is converted to WebP. */
    src?: string;
    path?: string;
    duplicate?: boolean;
  };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * YourImageShare has a documented JSON API (https://yourimageshare.com/ru/about/api):
 * `X-API-Key`, multipart field `uploads`, and a permanent `data.src` link. Keep
 * `visibility=unlisted`: the file stays hotlinkable but is not listed on their site.
 */
export function createYourImageShareMirror(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): MirrorHost {
  return {
    name: 'yourimageshare',
    maxBytes: YOURIMAGESHARE_MAX_BYTES,
    accepts(mime: string): boolean {
      return mime.startsWith('image/') || mime === 'video/mp4' || mime === 'video/webm';
    },
    async upload(input: UploadInput): Promise<UploadResult> {
      const body = await readFile(input.path);
      const form = new FormData();
      form.append(
        'uploads',
        new Blob([new Uint8Array(body)], { type: input.mime }),
        input.filename || basename(input.path),
      );
      form.append('visibility', 'unlisted');

      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: form,
      });

      // Their errors are JSON too, but a proxy may answer HTML; keep both readable.
      const text = await response.text();
      let json: YourImageShareResponse | null = null;
      try {
        json = JSON.parse(text) as YourImageShareResponse;
      } catch {
        // Treated as an unexpected response below.
      }

      const url = json?.data?.src;
      if (!response.ok || json?.type !== 'success' || !url) {
        const detail = json?.errors ?? text.slice(0, 200) ?? '';
        throw new Error(`yourimageshare: ${response.status} ${detail}`.trim());
      }
      return { url, remoteId: json.data?.id };
    },
  };
}
