// Token-bucket rate limiting, in memory, no dependency.
//
// /guard is limited per agent token (hashed), so one runaway or hijacked agent cannot
// starve the others; unauthenticated callers are limited per IP so tokens cannot be
// brute-forced. Operator writes are limited per IP. Single-instance by design.
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function createLimiter({ capacity, refillPerSec, now = Date.now }: { capacity: number; refillPerSec: number; now?: () => number }) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key: string): { ok: boolean; retryAfterSec: number; remaining: number } {
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

const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const off = () => process.env.SENTRA_RATE_LIMIT === 'off';
export const bearer = (req: FastifyRequest): string => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

/** A Fastify preHandler. keyOf(req) picks the bucket. */
export function rateLimit({ capacity, refillPerSec, keyOf }: { capacity: number; refillPerSec: number; keyOf: (req: FastifyRequest) => string }) {
  const limiter = createLimiter({ capacity, refillPerSec });
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (off()) return;
    const r = limiter.take(keyOf(req));
    reply.header('RateLimit-Remaining', String(r.remaining));
    if (r.ok) return;
    reply.header('Retry-After', String(r.retryAfterSec));
    return reply.code(429).send({ error: 'rate limit exceeded', retryAfterSec: r.retryAfterSec });
  };
}

export const guardLimiter = () => rateLimit({
  capacity: num(process.env.SENTRA_GUARD_BURST, 60),
  refillPerSec: num(process.env.SENTRA_GUARD_RPS, 2),
  keyOf: (req) => {
    const t = bearer(req);
    return t ? 'tok:' + crypto.createHash('sha256').update(t).digest('hex').slice(0, 16) : 'ip:' + req.ip;
  },
});

export const operatorLimiter = () => rateLimit({
  capacity: num(process.env.SENTRA_OPERATOR_BURST, 40),
  refillPerSec: num(process.env.SENTRA_OPERATOR_RPS, 1),
  keyOf: (req) => 'ip:' + req.ip,
});
