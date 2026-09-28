import { HttpError } from './http.js';

// Fixed-window counter per key (an IP, or an IP plus a username).
export class RateLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  hit(key) {
    const now = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > this.limit) throw new HttpError(429, 'too_many_attempts');
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
