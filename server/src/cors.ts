import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

/**
 * CORS for the public read API only. Browser clients on other origins can list
 * and search posts, but nothing that depends on a session: `/admin`, `/auth`,
 * `/me` and every mutating method are excluded, and credentials are never
 * allowed, so a malicious page cannot act as a signed-in visitor.
 */
const PRIVATE_PREFIXES = ['/api/v1/admin', '/api/v1/auth', '/api/v1/me'];

export function isPublicApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (path !== '/api/v1' && !path.startsWith('/api/v1/')) return false;
  return !PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function allowedOrigin(origin: string, config: Config): string | null {
  const configured = config.apiCorsOrigins;
  if (configured.length === 0) return null;
  if (configured.includes('*')) return '*';
  const lower = origin.toLowerCase();
  return configured.some((value) => value.toLowerCase() === lower) ? origin : null;
}

/**
 * Applies CORS headers and answers preflights. Returns true when the request was
 * fully handled, so the caller stops the lifecycle.
 */
export function applyCors(request: FastifyRequest, reply: FastifyReply, config: Config): boolean {
  if (!isPublicApiPath(request.url)) return false;
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  if (origin === 'null') return false;

  const allowed = allowedOrigin(origin, config);
  if (!allowed) return false;

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers['access-control-request-method'];
    if (!requestedMethod) return false;
    reply
      .header('access-control-allow-origin', allowed)
      .header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
      .header('access-control-allow-headers', 'accept, content-type, x-request-id')
      .header('access-control-max-age', '600');
    if (allowed !== '*') reply.header('vary', 'Origin');
    reply.code(204).send();
    return true;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  reply.header('access-control-allow-origin', allowed);
  reply.header('access-control-expose-headers', 'X-Request-Id, Retry-After');
  if (allowed !== '*') reply.header('vary', 'Origin');
  return false;
}
