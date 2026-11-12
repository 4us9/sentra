// Token-bucket rate limiting, in memory, no dependency.
//
// /guard is limited per agent token, so one runaway or hijacked agent cannot starve
// the others, and unauthenticated callers are limited per IP so tokens cannot be
// brute-forced. Operator writes are limited per IP.
// Single-instance by design; a multi-instance deployment needs a shared store.
import crypto from 'crypto';

/**
 * @param {{ capacity: number, refillPerSec: number, now?: () => number }} opts
 */
export function createLimiter({ capacity, refillPerSec, now = Date.now }) {
  /** @type {Map<string, { tokens: number, at: number }>} */
  const buckets = new Map();
  return {
    /** @returns {{ ok: boolean, retryAfterSec: number, remaining: number }} */
    take(key) {
      const t = now();
      const b = buckets.get(key) || { tokens: capacity, at: t };
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec);
      b.at = t;
      const ok = b.tokens >= 1;
      if (ok) b.tokens -= 1;
      buckets.set(key, b);
      if (buckets.size > 10_000) {                       // bound memory: drop full (idle) buckets
        for (const [k, v] of buckets) if (v.tokens >= capacity - 1 && t - v.at > 60_000) buckets.delete(k);
      }
      return { ok, retryAfterSec: ok ? 0 : Math.ceil((1 - b.tokens) / refillPerSec), remaining: Math.floor(b.tokens) };
    },
    size: () => buckets.size,
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const off = () => process.env.SENTRA_RATE_LIMIT === 'off';

/** Express middleware. keyOf(req) picks the bucket. */
export function rateLimit({ capacity, refillPerSec, keyOf }) {
  const limiter = createLimiter({ capacity, refillPerSec });
  return (req, res, next) => {
    if (off()) return next();
    const r = limiter.take(keyOf(req));
    res.set('RateLimit-Remaining', String(r.remaining));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'rate limit exceeded', retryAfterSec: r.retryAfterSec });
  };
}

const ip = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

// Per agent token (hashed, so the token itself is never used as a map key), else per IP.
export const guardLimiter = () => rateLimit({
  capacity: num(process.env.SENTRA_GUARD_BURST, 60),
  refillPerSec: num(process.env.SENTRA_GUARD_RPS, 2),
  keyOf: (req) => {
    const t = bearer(req);
    return t ? 'tok:' + crypto.createHash('sha256').update(t).digest('hex').slice(0, 16) : 'ip:' + ip(req);
  },
});

export const operatorLimiter = () => rateLimit({
  capacity: num(process.env.SENTRA_OPERATOR_BURST, 40),
  refillPerSec: num(process.env.SENTRA_OPERATOR_RPS, 1),
  keyOf: (req) => 'ip:' + ip(req),
});
