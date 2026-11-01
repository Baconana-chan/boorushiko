/** Small in-memory failure counter for login attempts. One process, one booru. */
export class AttemptThrottle {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.hits.get(key);
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      this.hits.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
    if (this.hits.size > 5000) this.prune(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}
