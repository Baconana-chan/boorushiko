import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimitRule {
  /** Requests allowed per window per scope. */
  max: number;
  windowMs: number;
}

/**
 * Fixed-window counters keyed by bucket + scope. One process, one booru: the
 * map is small and pruned opportunistically, so no Redis or extra dependency.
 * Windows are counted per authenticated user where possible, per IP otherwise.
 */
export const RATE_LIMITS = {
  /** New accounts per address per hour. */
  register: { max: 5, windowMs: 60 * 60 * 1000 },
  comment: { max: 20, windowMs: 10 * 60 * 1000 },
  report: { max: 10, windowMs: 60 * 60 * 1000 },
  uploaderRequest: { max: 3, windowMs: 24 * 60 * 60 * 1000 },
  upload: { max: 60, windowMs: 60 * 60 * 1000 },
  /** Public list/detail reads per address per minute. */
  apiPosts: { max: 300, windowMs: 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly enabled: boolean,
    private readonly rules: Record<string, RateLimitRule> = RATE_LIMITS,
  ) {}

  /** Returns 0 while the call is allowed, otherwise seconds until the window resets. */
  hit(bucket: string, scope: string): number {
    if (!this.enabled) return 0;
    const rule = this.rules[bucket];
    if (!rule) return 0;

    const now = Date.now();
    const key = `${bucket}:${scope}`;
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      this.prune(now);
      return 0;
    }
    if (window.count >= rule.max) {
      return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    }
    window.count += 1;
    return 0;
  }

  /** Called only when a window is created, so a burst of new keys stays bounded. */
  private prune(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * Applies a bucket to the caller and answers 429 itself. Returns null when the
 * request may continue, so routes read as a single guard line.
 */
export function rateLimited(
  limiter: RateLimiter,
  request: FastifyRequest,
  reply: FastifyReply,
  bucket: RateLimitBucket,
  scope = request.ip,
): FastifyReply | null {
  const retryAfterSeconds = limiter.hit(bucket, scope);
  if (retryAfterSeconds <= 0) return null;
  return reply.header('Retry-After', String(retryAfterSeconds)).code(429).send({
    error: 'too many requests, try again later',
    code: 'rate_limited',
    retryAfterSeconds,
  });
}
