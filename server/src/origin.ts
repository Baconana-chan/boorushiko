import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(',')[0]?.trim().toLowerCase();
  return first ? first : null;
}

/** The Host the browser used, including the port when it is not 80/443. */
function requestHost(request: FastifyRequest): string | null {
  return headerValue(request.headers['x-forwarded-host']) ?? headerValue(request.headers.host);
}

function configHost(config: Config): string | null {
  try {
    return new URL(config.publicBaseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Cookie-authenticated mutations must come from our own pages. Requests without
 * Origin or Referer pass: curl, the parser and other server-to-server clients
 * carry no browser cookies, and the bot endpoints need an explicit token anyway.
 * `Origin: null` is a browser sandbox and is rejected.
 */
export function isSameOriginRequest(request: FastifyRequest, config: Config): boolean {
  if (SAFE_METHODS.has(request.method)) return true;

  const origin = request.headers.origin;
  let source: string | null = null;
  if (typeof origin === 'string' && origin) {
    if (origin === 'null') return false;
    source = origin;
  } else if (typeof request.headers.referer === 'string' && request.headers.referer) {
    source = request.headers.referer;
  }
  if (!source) return true;

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.host.toLowerCase();
  return host === configHost(config) || host === requestHost(request);
}
