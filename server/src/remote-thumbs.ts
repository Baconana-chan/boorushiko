import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';
import type { EngineContext } from './context.js';
import { sniffMedia } from './media.js';

const MAX_REDIRECTS = 3;
const ACCEPT_IMAGES = 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8';
const USER_AGENT = 'BoorushikoThumb/0.1';
const PERMANENT_FAILURES = new Set([403, 404, 410]);
const PLACEHOLDER = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <rect width="300" height="300" fill="#14121c"/>
    <path d="M112 178l24-30 18 20 14-16 20 26z" fill="#3a3550"/>
    <circle cx="124" cy="112" r="12" fill="#3a3550"/>
    <text x="150" y="222" text-anchor="middle" font-family="monospace" font-size="12"
      fill="#8b849f">source unavailable</text>
  </svg>`,
);

interface OriginRow {
  id: number;
  pageUrl: string | null;
  fileUrl: string;
  previewUrl: string | null;
  refererPolicy: string | null;
}

export interface RemoteThumb {
  buffer: Buffer;
  contentType: string;
  etag: string;
  cacheable: boolean;
}

export interface RemoteThumbOptions {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
}

interface DownloadSuccess {
  buffer: Buffer;
  mime: string;
}

interface DownloadFailure {
  dead: boolean;
}

type DownloadResult = DownloadSuccess | DownloadFailure;

/** Small LRU for rendered previews. It never touches the filesystem. */
export class ThumbCache {
  private readonly entries = new Map<number, Buffer>();
  private totalBytes = 0;

  constructor(readonly maxBytes: number) {}

  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: number): Buffer | undefined {
    const value = this.entries.get(id);
    if (!value) return undefined;
    // Re-insert to mark this entry as the most recently used one.
    this.entries.delete(id);
    this.entries.set(id, value);
    return value;
  }

  set(id: number, value: Buffer): void {
    if (this.maxBytes <= 0 || value.length > this.maxBytes) return;
    const previous = this.entries.get(id);
    if (previous) {
      this.totalBytes -= previous.length;
      this.entries.delete(id);
    }
    while (this.totalBytes + value.length > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.totalBytes -= evicted.length;
    }
    this.entries.set(id, value);
    this.totalBytes += value.length;
  }
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function ipv6IsPublic(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? '';
  // Global unicast lives in 2000::/3. Loopback, ULA, link-local, multicast and
  // IPv4-mapped addresses are all outside it, so this stays conservative.
  if (!/^[23]/.test(lower)) return false;
  if (lower.startsWith('2001:db8')) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family === 6) return ipv6IsPublic(address);
  return false;
}

export async function assertPublicUrl(
  raw: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http and https sources are allowed');
  }
  if (url.username || url.password) throw new Error('source URL must not contain credentials');
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('source URL uses a forbidden port');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('source address is not public');
    return url;
  }

  const addresses = await resolveHost(hostname);
  if (addresses.length === 0) throw new Error('source host did not resolve');
  if (!addresses.every(isPublicAddress)) throw new Error('source address is not public');
  return url;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function readLimited(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('source image is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function refererFor(origin: OriginRow): string | null {
  const policy = origin.refererPolicy ?? 'none';
  if (policy === 'page') return origin.pageUrl ?? origin.fileUrl;
  if (policy === 'origin') {
    try {
      return new URL(origin.pageUrl ?? origin.fileUrl).origin + '/';
    } catch {
      return null;
    }
  }
  return null;
}

async function downloadImage(
  startUrl: string,
  referer: string | null,
  options: Required<
    Pick<RemoteThumbOptions, 'fetchImpl' | 'resolveHost' | 'maxBytes' | 'timeoutMs'>
  >,
): Promise<DownloadResult> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current, options.resolveHost);
    const headers: Record<string, string> = { accept: ACCEPT_IMAGES, 'user-agent': USER_AGENT };
    if (referer) headers.referer = referer;

    const response = await options.fetchImpl(current, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) return { dead: false };
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return { dead: PERMANENT_FAILURES.has(response.status) };
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body.cancel().catch(() => undefined);
      return { dead: false };
    }

    let buffer: Buffer;
    try {
      buffer = await readLimited(response.body, options.maxBytes);
    } catch {
      return { dead: false };
    }
    const media = sniffMedia(buffer.subarray(0, 64));
    if (!media || media.kind !== 'image') return { dead: false };
    return { buffer, mime: media.mime };
  }

  return { dead: false };
}

async function renderThumb(buffer: Buffer): Promise<Buffer> {
  return (
    sharp(buffer, { limitInputPixels: 50_000_000 })
      .rotate()
      // 480px covers a ~240px grid cell on a 2x display without upscaling.
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
  );
}

async function loadPreview(
  ctx: EngineContext,
  postId: number,
  options: Required<
    Pick<RemoteThumbOptions, 'fetchImpl' | 'resolveHost' | 'maxBytes' | 'timeoutMs'>
  >,
): Promise<Buffer | null> {
  const origins = ctx.sqlite
    .prepare(
      `SELECT id, page_url AS pageUrl, file_url AS fileUrl,
              preview_url AS previewUrl, referer_policy AS refererPolicy
       FROM post_origins
       WHERE post_id = ? AND status = 'ok'
       ORDER BY id ASC`,
    )
    .all(postId) as OriginRow[];

  for (const origin of origins) {
    const candidates = [
      ...new Set([origin.previewUrl, origin.fileUrl].filter(Boolean)),
    ] as string[];
    let fileDead = false;

    for (const candidate of candidates) {
      let result: DownloadResult;
      try {
        result = await downloadImage(candidate, refererFor(origin), options);
      } catch {
        // Timeouts, 5xx and DNS hiccups are not proof that the source is dead.
        continue;
      }
      if (!('buffer' in result)) {
        if (result.dead && candidate === origin.fileUrl) fileDead = true;
        continue;
      }
      try {
        return await renderThumb(result.buffer);
      } catch {
        // The host returned 200 but not an image sharp can decode; try the next URL.
      }
    }

    if (fileDead) {
      ctx.sqlite
        .prepare("UPDATE post_origins SET status = 'source_dead', checked_at = ? WHERE id = ?")
        .run(new Date().toISOString(), origin.id);
    }
  }

  return null;
}

function etagOf(buffer: Buffer): string {
  return `"${createHash('sha1').update(buffer).digest('base64url').slice(0, 20)}"`;
}

export interface RemoteThumbService {
  get(postId: number): Promise<RemoteThumb>;
}

export function createRemoteThumbService(
  ctx: EngineContext,
  options: RemoteThumbOptions = {},
): RemoteThumbService {
  const resolved = {
    fetchImpl: options.fetchImpl ?? fetch,
    resolveHost: options.resolveHost ?? defaultResolveHost,
    maxBytes: options.maxBytes ?? ctx.config.remoteThumbMaxBytes,
    timeoutMs: options.timeoutMs ?? ctx.config.remoteThumbTimeoutMs,
  };
  const cache = new ThumbCache(Math.max(0, ctx.config.remoteThumbCacheMb) * 1024 * 1024);
  const inflight = new Map<number, Promise<Buffer | null>>();

  return {
    async get(postId: number): Promise<RemoteThumb> {
      const cached = cache.get(postId);
      if (cached) {
        return {
          buffer: cached,
          contentType: 'image/webp',
          etag: etagOf(cached),
          cacheable: true,
        };
      }

      let pending = inflight.get(postId);
      if (!pending) {
        pending = loadPreview(ctx, postId, resolved);
        inflight.set(postId, pending);
        void pending.then(
          () => {
            if (inflight.get(postId) === pending) inflight.delete(postId);
          },
          () => {
            if (inflight.get(postId) === pending) inflight.delete(postId);
          },
        );
      }
      const thumb = await pending;

      if (!thumb) {
        return {
          buffer: PLACEHOLDER,
          contentType: 'image/svg+xml',
          etag: etagOf(PLACEHOLDER),
          cacheable: false,
        };
      }

      cache.set(postId, thumb);
      return { buffer: thumb, contentType: 'image/webp', etag: etagOf(thumb), cacheable: true };
    },
  };
}
