import './env.js';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import * as store from './store.js';
import * as paypal from './paypal.js';
import { createMandate, publicMandate } from './mandate.js';
import { guardPayment, resolveReview, setFrozen, auditStatus, mandateForToken } from './guard.js';
import { llmConfigured } from './intent.js';
import { SCENARIOS, POISONED_LISTING } from '../agent/scenarios.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// The dashboard renders text that an attacker-controlled agent supplied, so it is
// locked down: no inline script, scripts only from self and the AG Grid CDN.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

const send = (res) => (r) => res.status(r.status).json(r.body);
const sendMandate = (res) => (r) => res.status(r.status).json(r.status === 200 ? publicMandate(r.body) : r.body);
const fail = (res) => (e) => res.status(500).json({ error: String(e.message || e) });
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const config = () => ({
  paypal: paypal.mode(),
  intent: llmConfigured() ? 'llm' : 'fallback',
  operatorAuth: Boolean(process.env.SENTRA_ADMIN_TOKEN),
});

// Operator endpoints. Open in demo mode; set SENTRA_ADMIN_TOKEN to require it.
function operator(req, res, next) {
  const want = process.env.SENTRA_ADMIN_TOKEN;
  if (!want) return next();
  const got = Buffer.from(req.get('x-sentra-admin') || '');
  const exp = Buffer.from(want);
  if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) return next();
  res.status(401).json({ error: 'operator token required' });
}

app.get('/health', (req, res) => res.json({ ok: true, ...config() }));

// ---- Agent surface: one endpoint. The token decides which mandate applies. ----
app.post('/guard', (req, res) => guardPayment(bearer(req), req.body).then(send(res), fail(res)));
app.get('/guard/mandate', (req, res) => {
  const m = mandateForToken(bearer(req));
  if (!m) return res.status(401).json({ error: 'missing or invalid agent token' });
  res.json(publicMandate(m));
});

// ---- Operator / dashboard surface ----
app.get('/api/state', (req, res) => res.json({
  mandates: store.listMandates().map(publicMandate),
  decisions: store.listDecisions(),
  audit: auditStatus(),
  config: config(),
}));
app.get('/api/scenarios', (req, res) => res.json({ scenarios: SCENARIOS, poisonedListing: POISONED_LISTING }));
app.get('/api/audit/verify', (req, res) => res.json(auditStatus()));

app.post('/api/mandates', operator, (req, res) => {
  try {
    const { mandate, agentToken } = createMandate(req.body || {});
    store.saveMandate(mandate);
    res.json({ mandate: publicMandate(mandate), agentToken });   // token is shown once
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/mandates/:id/freeze', operator, (req, res) => setFrozen(req.params.id, true).then(sendMandate(res), fail(res)));
app.post('/api/mandates/:id/reinstate', operator, (req, res) => setFrozen(req.params.id, false).then(sendMandate(res), fail(res)));
app.post('/api/reviews/:id/:action', operator, (req, res) => resolveReview(req.params.id, req.params.action).then(send(res), fail(res)));
app.post('/api/demo/reset', operator, (req, res) => { store.reset(); res.json({ ok: true }); });

// Malformed JSON and oversized bodies get a clean 400, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'request too large' : 'malformed request' });
});

app.use(express.static(path.resolve('public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sentra running on http://localhost:${PORT}`);
  console.log(`  PayPal: ${paypal.mode() === 'sandbox' ? 'SANDBOX (real sandbox orders)' : 'SIMULATED (no credentials in .env; order ids start with SIM-)'}`);
  console.log(`  Intent: ${llmConfigured() ? 'Claude + signatures' : 'signatures + vocabulary fallback (no ANTHROPIC_API_KEY)'}`);
});
