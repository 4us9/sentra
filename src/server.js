import './env.js';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import * as store from './store.js';
import { getProcessor, processorStatus } from './processors/index.js';
import { createMandate, publicMandate } from './mandate.js';
import { guardPayment, resolveReview, setFrozen, recordIssued, resetGuardState, auditStatus, mandateForToken, reservedTotal } from './guard.js';
import { llmConfigured, intentModel } from './intent.js';
import { loadPolicies, mandateFromPolicy } from './policy/config.js';
import { queryLedger, toCsv, computeMetrics, toPrometheus } from './ledger.js';
import { guardLimiter, operatorLimiter } from './ratelimit.js';
import { SCENARIOS, POISONED_LISTING } from '../agent/scenarios.js';

// A bad policy file must stop the server, not silently fall back to defaults.
const POLICIES = loadPolicies();
const DEFAULT_POLICY = process.env.SENTRA_DEFAULT_POLICY || 'grocery-run';

const app = express();
app.disable('x-powered-by');
if (process.env.SENTRA_TRUST_PROXY) app.set('trust proxy', 1);     // set on Render etc. so rate limits see the real client IP
app.use(express.json({ limit: '10kb' }));

// The dashboard renders text that an attacker-controlled agent supplied, so it is
// locked down: no inline script, scripts only from self and the AG Grid CDN.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 */

/** @param {Response} res @returns {(r: { status: number, body: unknown }) => void} */
const send = (res) => (r) => res.status(r.status).json(r.body);
/** @param {Response} res @returns {(r: import('./types.js').FreezeResponse) => void} */
const sendMandate = (res) => (r) => res.status(r.status).json(r.status === 200 ? publicMandate(r.body) : r.body);
/** @param {Response} res @returns {(e: unknown) => void} */
const fail = (res) => (e) => { console.error('[server]', /** @type {{ message?: unknown } | null | undefined} */ (e)?.message || e); res.status(500).json({ error: 'internal error' }); };
/** @param {Request} req */
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const config = () => ({
  paypal: getProcessor('paypal').mode(),
  processors: processorStatus(),
  intent: llmConfigured() ? 'llm' : 'fallback',
  intentModel: llmConfigured() ? intentModel() : null,
  operatorAuth: Boolean(process.env.SENTRA_ADMIN_TOKEN),
  policies: Object.keys(POLICIES),
  defaultPolicy: POLICIES[DEFAULT_POLICY] ? DEFAULT_POLICY : null,
});
const metrics = () => {
  const mandates = store.listMandates();
  return computeMetrics(store.listDecisions(), mandates, { reserved: mandates.reduce((a, m) => a + reservedTotal(m.id), 0) });
};

// Operator endpoints. Open in demo mode; set SENTRA_ADMIN_TOKEN to require it.
/** @param {Request} req @param {Response} res @param {NextFunction} next */
function operator(req, res, next) {
  const want = process.env.SENTRA_ADMIN_TOKEN;
  if (!want) return next();
  const got = Buffer.from(req.get('x-sentra-admin') || '');
  const exp = Buffer.from(want);
  if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) return next();
  res.status(401).json({ error: 'operator token required' });
}
const opLimit = operatorLimiter();

app.get('/health', (req, res) => res.json({ ok: true, ...config() }));

// ---- Agent surface: one endpoint. The token decides which mandate applies. ----
app.post('/guard', guardLimiter(), (req, res) => guardPayment(bearer(req), req.body).then(send(res), fail(res)));
app.get('/guard/mandate', guardLimiter(), (req, res) => {
  const m = mandateForToken(bearer(req));
  if (!m) return res.status(401).json({ error: 'missing or invalid agent token' });
  res.json(publicMandate(m));
});

// ---- Read surface: state, ledger, metrics ----
app.get('/api/state', (req, res) => res.json({
  mandates: store.listMandates().map((m) => ({ ...publicMandate(m), reserved: reservedTotal(m.id) })),
  decisions: store.listDecisions(),
  audit: auditStatus(),
  metrics: metrics(),
  config: config(),
}));
app.get('/api/scenarios', (req, res) => res.json({ scenarios: SCENARIOS, poisonedListing: POISONED_LISTING }));
app.get('/api/policies', (req, res) => res.json({ policies: Object.values(POLICIES), default: config().defaultPolicy }));
app.get('/api/audit/verify', (req, res) => res.json(auditStatus()));

// Query the ledger: ?verdict=BLOCK,REVIEW&layer=intent&processor=stripe&mandate=..&since=..&until=..&q=..&limit=..&offset=..
// Add &format=csv for an export an auditor can open in a spreadsheet.
app.get('/api/ledger', (req, res) => {
  const result = queryLedger(store.listDecisions(), req.query);
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sentra-ledger.csv"' });
    return res.send(toCsv(result.entries));
  }
  res.json({ ...result, audit: auditStatus() });
});
app.get('/api/metrics', (req, res) => res.json(metrics()));
app.get('/metrics', (req, res) => res.type('text/plain; version=0.0.4').send(toPrometheus(metrics(), auditStatus())));

// ---- Operator surface ----
// Body: { policy?: "<name in policies/>", processor?: "paypal"|"stripe", ...field overrides }
app.post('/api/mandates', opLimit, operator, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { policy: wanted, ...overrides } = body;
    const name = wanted ?? (POLICIES[DEFAULT_POLICY] ? DEFAULT_POLICY : null);
    if (name && !POLICIES[name]) return res.status(400).json({ error: `unknown policy "${String(name).slice(0, 64)}"` });
    const base = name ? mandateFromPolicy(POLICIES[name]) : {};
    // Only these may be set per mandate. Everything else comes from the policy file,
    // and the id is always freshly generated: accepting one would let a caller
    // replace an existing mandate.
    const allowed = Object.fromEntries(['processor', 'user'].filter((k) => k in overrides).map((k) => [k, overrides[k]]));
    const unknown = Object.keys(overrides).filter((k) => !(k in allowed));
    if (unknown.length) return res.status(400).json({ error: `not settable per mandate: ${unknown.slice(0, 5).join(', ').slice(0, 120)}. Put limits in a policy file.` });
    const { mandate, agentToken } = createMandate({ ...base, ...allowed });
    store.saveMandate(mandate);
    await recordIssued(mandate);                                  // issuance is on the ledger too
    res.json({ mandate: publicMandate(mandate), agentToken });   // token is shown once
  } catch (e) { res.status(400).json({ error: String(/** @type {{ message?: unknown }} */ (e).message || e) }); }
});
app.post('/api/mandates/:id/freeze', opLimit, operator, (req, res) => setFrozen(/** @type {string} */ (req.params.id), true).then(sendMandate(res), fail(res)));
app.post('/api/mandates/:id/reinstate', opLimit, operator, (req, res) => setFrozen(/** @type {string} */ (req.params.id), false).then(sendMandate(res), fail(res)));
app.post('/api/reviews/:id/:action', opLimit, operator, (req, res) => resolveReview(/** @type {string} */ (req.params.id), /** @type {string} */ (req.params.action)).then(send(res), fail(res)));
app.post('/api/demo/reset', opLimit, operator, (req, res) => { store.reset(); resetGuardState(); res.json({ ok: true }); });

app.use(express.static(path.resolve('public')));

// Malformed JSON and oversized bodies get a clean 400, never a stack trace.
app.use(/** @type {import('express').ErrorRequestHandler} */ ((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'request too large' : 'malformed request' });
}));

export { app };

if (!process.env.SENTRA_NO_LISTEN) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Sentra running on http://localhost:${PORT}`);
    for (const p of processorStatus()) {
      console.log(`  ${p.label}: ${p.mode === 'simulated' ? 'SIMULATED (no credentials; payment ids start with SIM-)' : p.mode.toUpperCase()}${p.default ? '  [default]' : ''}`);
    }
    console.log(`  Intent: ${llmConfigured() ? `Claude (${intentModel()}) + signatures` : 'signatures + vocabulary fallback (no ANTHROPIC_API_KEY)'}`);
    console.log(`  Policies: ${Object.keys(POLICIES).join(', ') || 'none'}`);
  });
}
