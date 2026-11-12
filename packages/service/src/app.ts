// The HTTP surface (Fastify). Routes and JSON shapes are those of Sentra 0.3, plus
// operator API keys and a storage health block.
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  createMandate, publicMandate, mandateFromPolicy, validatePolicy, queryLedger, toCsv, computeMetrics, toPrometheus,
  type Policy, type FreezeResponse, type LedgerQuery,
} from '@sentra/guard';
import type { Store } from '@sentra/db';
import type { Guard } from './guard.js';
import { processorStatus, getProcessor } from './processors/index.js';
import { llmConfigured, intentModel } from './llm.js';
import { guardLimiter, operatorLimiter, bearer } from './ratelimit.js';
import { requireOperator, operatorOf, operatorAuthEnabled, mintApiKey, type Scope } from './auth.js';
import { SCENARIOS, POISONED_LISTING } from './agent/scenarios.js';

/** Load and validate every policy file. Throws on the first invalid one: a bad policy must not start the server. */
export function loadPolicies(dir: string): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.schema.json')).sort()) {
    let parsed: Policy;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (err) { throw new Error(`policies/${f}: not valid JSON (${(err as Error).message})`); }
    const problems = validatePolicy(parsed);
    if (problems.length) throw new Error(`policies/${f}: ${problems.join('; ')}`);
    if (out[parsed.name]) throw new Error(`policies/${f}: duplicate policy name "${parsed.name}"`);
    out[parsed.name] = parsed;
  }
  return out;
}

export interface AppDeps {
  store: Store;
  guard: Guard;
  policies: Record<string, Policy>;
  defaultPolicy?: string;
  /** Directory of the bundled single-page dashboard; omit to serve none. */
  publicDir?: string | null;
  /** Origins allowed to call the API from a browser (the Next.js app). */
  corsOrigins?: string[];
  trustProxy?: boolean;
}

// The dashboard renders text an attacker-controlled agent supplied, so it is locked
// down: no inline script, scripts only from self and the AG Grid CDN.
const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export async function buildApp({ store, guard, policies, defaultPolicy = 'grocery-run', publicDir = null, corsOrigins = [], trustProxy = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024, trustProxy });

  // Empty JSON body = {}; malformed JSON = a clean 400, never a stack trace.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body || '').trim();
    if (!text) return done(null, {});
    try { done(null, JSON.parse(text)); }
    catch { const e = new Error('malformed request') as FastifyError; e.statusCode = 400; done(e, undefined); }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
  });

  if (corsOrigins.length) {
    await app.register(cors, {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['content-type', 'authorization', 'x-sentra-admin'],
      maxAge: 600,
    });
  }

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) console.error('[server]', String(err.message || err).slice(0, 300));
    const error = status === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'request too large' : status === 500 ? 'internal error' : 'malformed request';
    reply.code(status === 413 ? 413 : status).send({ error });
  });

  const defaultName = policies[defaultPolicy] ? defaultPolicy : null;
  const config = () => ({
    paypal: getProcessor('paypal').mode(),
    processors: processorStatus(),
    intent: llmConfigured() ? 'llm' : 'fallback',
    intentModel: llmConfigured() ? intentModel() : null,
    operatorAuth: operatorAuthEnabled(store),
    policies: Object.keys(policies),
    defaultPolicy: defaultName,
    storage: store.health(),
  });
  const metrics = () => {
    const mandates = store.listMandates();
    return computeMetrics(store.listDecisions(), mandates, { reserved: mandates.reduce((a, m) => a + guard.reservedTotal(m.id), 0) });
  };
  const sendMandate = (r: FreezeResponse) => ({ status: r.status, body: r.status === 200 ? publicMandate(r.body) : r.body });
  const op = (scope: Scope, extra: { rootOnly?: boolean } = {}) => ({ preHandler: [operatorLimiter(), requireOperator(store, scope, extra)] });
  const agentLimit = { preHandler: guardLimiter() };

  app.get('/health', async () => ({ ok: store.health().durable, ...config() }));

  // ---- Agent surface: one endpoint. The token decides which mandate applies. ----
  app.post('/guard', agentLimit, async (req, reply) => {
    const r = await guard.guardPayment(bearer(req), req.body);
    return reply.code(r.status).send(r.body);
  });
  app.get('/guard/mandate', agentLimit, async (req, reply) => {
    const m = guard.mandateForToken(bearer(req));
    if (!m) return reply.code(401).send({ error: 'missing or invalid agent token' });
    return publicMandate(m);
  });

  // ---- Read surface ----
  app.get('/api/state', async () => ({
    mandates: store.listMandates().map((m) => ({ ...publicMandate(m), reserved: guard.reservedTotal(m.id) })),
    decisions: store.listDecisions(),
    audit: guard.auditStatus(),
    metrics: metrics(),
    config: config(),
  }));
  app.get('/api/scenarios', async () => ({ scenarios: SCENARIOS, poisonedListing: POISONED_LISTING }));
  app.get('/api/policies', async () => ({ policies: Object.values(policies), default: defaultName }));
  app.get('/api/audit/verify', async () => guard.auditStatus());
  // ?verdict=BLOCK,REVIEW&layer=intent&processor=stripe&mandate=..&since=..&until=..&q=..&limit=..&offset=..[&format=csv]
  app.get('/api/ledger', async (req, reply) => {
    const q = req.query as LedgerQuery & { format?: string };
    const result = queryLedger(store.listDecisions(), q);
    if (q.format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="sentra-ledger.csv"');
      return reply.send(toCsv(result.entries));
    }
    return { ...result, audit: guard.auditStatus() };
  });
  app.get('/api/metrics', async () => metrics());
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(toPrometheus(metrics(), guard.auditStatus())));

  // ---- Operator surface ----
  // Body: { policy?: "<name in policies/>", processor?, user? }. Everything else comes from the policy file.
  app.post('/api/mandates', op('admin'), async (req, reply) => {
    try {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const { policy: wanted, ...overrides } = body;
      const name = (wanted ?? defaultName) as string | null;
      if (name && !policies[name]) return reply.code(400).send({ error: `unknown policy "${String(name).slice(0, 64)}"` });
      const base = name ? mandateFromPolicy(policies[name]) : {};
      // Only these may be set per mandate; the id is always fresh (accepting one
      // would let a caller replace an existing mandate).
      const allowed = Object.fromEntries(['processor', 'user'].filter((k) => k in overrides).map((k) => [k, overrides[k]]));
      const unknown = Object.keys(overrides).filter((k) => !(k in allowed));
      if (unknown.length) return reply.code(400).send({ error: `not settable per mandate: ${unknown.slice(0, 5).join(', ').slice(0, 120)}. Put limits in a policy file.` });
      const { mandate, agentToken } = createMandate({ ...base, ...allowed });
      store.saveMandate(mandate);
      await guard.recordIssued(mandate, { operator: operatorOf(req).label });   // issuance is on the ledger too
      return { mandate: publicMandate(mandate), agentToken };                    // the token is shown once
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message || e).slice(0, 300) });
    }
  });
  app.post<{ Params: { id: string } }>('/api/mandates/:id/freeze', op('admin'), async (req, reply) => {
    const r = sendMandate(await guard.setFrozen(req.params.id, true, { operator: operatorOf(req).label }));
    return reply.code(r.status).send(r.body);
  });
  app.post<{ Params: { id: string } }>('/api/mandates/:id/reinstate', op('admin'), async (req, reply) => {
    const r = sendMandate(await guard.setFrozen(req.params.id, false, { operator: operatorOf(req).label }));
    return reply.code(r.status).send(r.body);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/reviews/:id/:action', op('admin'), async (req, reply) => {
    const r = await guard.resolveReview(req.params.id, req.params.action, { operator: operatorOf(req).label });
    return reply.code(r.status).send(r.body);
  });
  app.post('/api/demo/reset', op('admin'), async () => {
    store.reset();
    guard.resetGuardState();
    await store.flush();
    return { ok: true };
  });

  // ---- Operator API keys (root credential only) ----
  app.get('/api/keys', op('admin', { rootOnly: true }), async () => ({
    keys: store.listApiKeys().map(({ keyHash: _h, ...k }) => k),
  }));
  app.post('/api/keys', op('admin', { rootOnly: true }), async (req, reply) => {
    const b = (req.body || {}) as { label?: unknown; scopes?: unknown };
    const scopes = Array.isArray(b.scopes) ? b.scopes : ['admin', 'read'];
    if (!scopes.length || !scopes.every((s) => s === 'admin' || s === 'read')) return reply.code(400).send({ error: 'scopes must be a non-empty subset of ["admin","read"]' });
    const out = mintApiKey(store, typeof b.label === 'string' ? b.label : 'operator', scopes as Scope[]);
    await store.flush();
    return out;                                                                 // the key is shown once
  });
  app.post<{ Params: { id: string } }>('/api/keys/:id/revoke', op('admin', { rootOnly: true }), async (req, reply) => {
    const k = store.listApiKeys().find((x) => x.id === req.params.id);
    if (!k) return reply.code(404).send({ error: 'unknown key' });
    store.saveApiKey({ ...k, revokedAt: k.revokedAt || new Date().toISOString() });
    await store.flush();
    return { ok: true };
  });

  if (publicDir && fs.existsSync(publicDir)) await app.register(fastifyStatic, { root: path.resolve(publicDir) });
  return app;
}
