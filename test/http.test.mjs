// HTTP surface, SDK, policy-as-config, ledger export, metrics, rate limiting and the
// offline verifier. Starts the real Express app on an ephemeral port. No network
// beyond localhost, simulated processors, no model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-http-'));
process.env.SENTRA_DATA_DIR = DATA;
process.env.SENTRA_SECRET = 'test-secret';
process.env.SENTRA_PROCESSOR_MODE = 'simulate';
process.env.SENTRA_NO_DOTENV = '1';
process.env.SENTRA_NO_LISTEN = '1';
process.env.SENTRA_GUARD_BURST = '25';
process.env.SENTRA_GUARD_RPS = '0.001';
process.env.SENTRA_OPERATOR_BURST = '1000';
for (const k of ['ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'STRIPE_SECRET_KEY', 'SENTRA_ADMIN_TOKEN']) delete process.env[k];

const { app } = await import('../src/server.js');
const { Sentra, PaymentRefused, SentraError } = await import('../sdk/index.js');
const { validatePolicy, loadPolicies, mandateFromPolicy } = await import('../src/policy/config.js');
const { csvCell, queryLedger, computeMetrics } = await import('../src/ledger.js');
const { createLimiter } = await import('../src/ratelimit.js');
const store = await import('../src/store.js');

let server; let base;
before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = async (p, body, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text(), headers: r.headers }; };
const issue = async (body = {}) => (await post('/api/mandates', body)).body;
const ok = { amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' };

// ---------- policy-as-config ----------
test('policy: shipped policy files are valid and load', () => {
  const p = loadPolicies();
  assert.ok(p['grocery-run'] && p['saas-procurement']);
  for (const policy of Object.values(p)) assert.deepEqual(validatePolicy(policy), []);
});
test('policy: validator is strict (typos, bad limits, missing allowlist)', () => {
  const good = loadPolicies()['grocery-run'];
  assert.match(validatePolicy({ ...good, perTxcap: 10 }).join(), /unknown field "perTxcap"/);
  assert.match(validatePolicy({ ...good, version: 2 }).join(), /version/);
  assert.match(validatePolicy({ ...good, perTxCap: 9999 }).join(), /cannot exceed/);
  assert.match(validatePolicy({ ...good, allowedRecipients: [] }).join(), /non-empty/);
  assert.match(validatePolicy({ ...good, allowedRecipients: ['ok', 'bаd'] }).join(), /invalid id/);
  assert.match(validatePolicy({ ...good, budgetTotal: '300' }).join(), /budgetTotal/);
  assert.match(validatePolicy({ ...good, processor: 'venmo' }).join(), /processor/);
  assert.match(validatePolicy({ ...good, outOfScope: 'allow' }).join(), /outOfScope/);
  assert.match(validatePolicy(null).join(), /object/);
});
test('policy: a bad policy file stops loading instead of falling back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-pol-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ version: 1, name: 'bad', description: 'x', budgetTotal: -1, perTxCap: 5, allowedRecipients: ['a'] }));
  assert.throws(() => loadPolicies(dir), /bad\.json: budgetTotal/);
});
test('policy: mandate issued from a policy carries its limits, name and expiry', async () => {
  const { mandate } = await issue({ policy: 'saas-procurement', processor: 'stripe' });
  assert.equal(mandate.policy, 'saas-procurement');
  assert.equal(mandate.budgetTotal, 2000);
  assert.equal(mandate.outOfScope, 'block');
  assert.equal(mandate.processor, 'stripe');
  assert.equal(mandate.sealValid, true);
  const ttl = (Date.parse(mandate.expiresAt) - Date.now()) / 3600e3;
  assert.ok(ttl > 71 && ttl <= 72);
  assert.equal(mandateFromPolicy(loadPolicies()['grocery-run'], 0).expiresAt, new Date(24 * 3600e3).toISOString());
  assert.equal((await post('/api/mandates', { policy: 'no-such-policy' })).status, 400);
  assert.equal((await post('/api/mandates', { policy: 'grocery-run', processor: 'venmo' })).status, 400);
});

// ---------- SDK over real HTTP ----------
test('sdk: guard, guardOrThrow, mandate, protect', async () => {
  const { mandate, agentToken } = await issue({ policy: 'grocery-run' });
  const sentra = new Sentra({ url: base, agentToken });
  const d = await sentra.guard(ok);
  assert.equal(d.verdict, 'ALLOW');
  assert.equal(d.decidedBy, null);
  assert.match(d.paymentId, /^SIM-PAYPAL-/);
  assert.equal((await sentra.mandate()).id, mandate.id);

  const blocked = await sentra.guard({ ...ok, amount: 5000, recipient: 'wallet_unknown_0xABCD' });
  assert.equal(blocked.verdict, 'BLOCK');
  assert.deepEqual(blocked.decidedBy, { layer: 'rule', check: 'per_tx_cap' });

  await assert.rejects(() => sentra.guardOrThrow({ ...ok, purpose: 'gift card' }), (e) => e instanceof PaymentRefused && e.verdict === 'BLOCK' && e.decision.decidedBy.layer === 'intent');

  let ran = 0;
  const pay = sentra.protect(async (payment, decision) => { ran++; return `${payment.amount}:${decision.verdict}`; });
  assert.equal(await pay({ ...ok, amount: 5 }), '5:ALLOW');
  await assert.rejects(() => pay({ ...ok, amount: -5 }), PaymentRefused);
  assert.equal(ran, 1, 'the wrapped function must not run for a refused payment');
});
test('sdk: bad token is a SentraError 401; missing token is refused up front', async () => {
  await assert.rejects(() => new Sentra({ url: base, agentToken: 'sat_nope' }).guard(ok), (e) => e instanceof SentraError && e.status === 401);
  assert.throws(() => new Sentra({ url: base }), SentraError);
});

// ---------- HTTP hardening ----------
test('http: security headers, malformed JSON, oversized body, no stack traces', async () => {
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
  assert.ok(!/unsafe-inline/.test(page.headers.get('content-security-policy').split('script-src')[1].split(';')[0]));
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-powered-by'), null);

  const { agentToken } = await issue();
  const auth = { Authorization: `Bearer ${agentToken}` };
  const bad = await post('/guard', '{not json', auth);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'malformed request' });
  const big = await post('/guard', { ...ok, purpose: 'x'.repeat(20000) }, auth);
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { error: 'request too large' });
});
test('http: the dashboard API never exposes token hashes or seals', async () => {
  await issue();
  const state = JSON.parse((await get('/api/state')).text);
  assert.ok(state.mandates.length > 0);
  for (const m of state.mandates) { assert.equal(m.tokenHash, undefined); assert.equal(m.seal, undefined); }
  assert.ok(!/sat_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(state)));
});
test('http: /guard is rate limited per agent token; other agents are unaffected', async () => {
  const a = await issue(); const b = await issue();
  const hit = (tok) => post('/guard', { ...ok, amount: 1 }, { Authorization: `Bearer ${tok}` });
  const out = [];
  for (let i = 0; i < 30; i++) out.push((await hit(a.agentToken)).status);
  assert.equal(out.filter((s) => s === 200).length, 25);
  assert.equal(out.filter((s) => s === 429).length, 5);
  const limited = await hit(a.agentToken);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await hit(b.agentToken)).status, 200);
});
test('ratelimit: bucket refills over time', () => {
  let t = 0;
  const l = createLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.equal(l.take('k').ok, true);
  assert.equal(l.take('k').ok, true);
  assert.equal(l.take('k').ok, false);
  t += 1000;
  assert.equal(l.take('k').ok, true);
  assert.equal(l.take('other').ok, true);
});

// ---------- ledger, export, metrics ----------
test('ledger: query by verdict, layer, processor and text; CSV export', async () => {
  store.reset();
  const p = await issue({ processor: 'paypal' });
  const s = await issue({ processor: 'stripe' });
  const sp = new Sentra({ url: base, agentToken: p.agentToken });
  const ss = new Sentra({ url: base, agentToken: s.agentToken });
  await sp.guard(ok);
  await ss.guard(ok);
  await sp.guard({ ...ok, purpose: 'gift card' });
  await ss.guard({ ...ok, amount: -1 });
  await ss.guard({ ...ok, purpose: '=HYPERLINK("http://evil.example","click")' });

  const q = async (qs) => JSON.parse((await get('/api/ledger?' + qs)).text);
  assert.equal((await q('')).total, 5);
  assert.equal((await q('verdict=ALLOW')).total, 2);
  assert.equal((await q('verdict=BLOCK,REVIEW')).total, 3);
  assert.equal((await q('layer=intent')).total, 2);
  assert.equal((await q('layer=schema')).entries[0].decidedBy.check, 'amount_format');
  assert.equal((await q('processor=stripe')).total, 3);
  assert.equal((await q('q=gift')).total, 1);
  assert.equal((await q(`mandate=${p.mandate.id}`)).total, 2);
  assert.equal((await q('limit=2&offset=4')).entries.length, 1);
  assert.equal((await q('')).audit.ok, true);

  const csv = await get('/api/ledger?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^seq,time,decision_id,.*decided_by_layer,decided_by_check,.*prev_hash,hash$/);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), 'formula cell must be neutralised');
});
test('ledger: csv cells are escaped and formula-safe', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-150'), "'-150");
  assert.equal(csvCell(-150), '-150');          // real numbers stay numbers
  assert.equal(csvCell(null), '');
});
test('metrics: JSON and Prometheus views agree with the ledger', async () => {
  const m = JSON.parse((await get('/api/metrics')).text);
  assert.equal(m.decisions, 5);
  assert.deepEqual(m.byVerdict, { ALLOW: 2, BLOCK: 3, REVIEW: 0, ERROR: 0 });
  assert.equal(m.blockRate, 0.6);
  assert.deepEqual(m.spendByProcessor, { paypal: 40, stripe: 40 });
  assert.deepEqual(m.stoppedByLayer, { intent: 2, schema: 1 });
  assert.equal(m.blockedValue, 80);
  assert.ok(m.latencyMs.p95 >= m.latencyMs.p50);

  const prom = (await get('/metrics')).text;
  assert.match(prom, /sentra_decisions_total\{verdict="BLOCK"\} 3/);
  assert.match(prom, /sentra_spend_total\{processor="stripe"\} 40/);
  assert.match(prom, /sentra_ledger_intact 1/);
  assert.match(prom, /sentra_decision_latency_ms\{quantile="0\.95"\}/);
});
test('metrics: empty ledger does not divide by zero', () => {
  const m = computeMetrics([], []);
  assert.equal(m.blockRate, 0);
  assert.equal(m.latencyMs.p95, 0);
  assert.equal(queryLedger([], {}).total, 0);
});

// ---------- offline verifier ----------
test('verify-ledger: exits 0 on an intact ledger and 1 after tampering', async () => {
  const run = () => spawnSync(process.execPath, ['scripts/verify-ledger.js', path.join(DATA, 'db.json')], {
    encoding: 'utf8', env: { ...process.env, SENTRA_DATA_DIR: DATA },
  });
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /ledger\s+OK/);

  const file = path.join(DATA, 'db.json');
  const original = fs.readFileSync(file, 'utf8');
  const db = JSON.parse(original);
  db.decisions[2].verdict = 'ALLOW';                                   // rewrite a BLOCK
  Object.values(db.mandates)[0].budgetTotal = 1e9;                     // and raise a limit
  fs.writeFileSync(file, JSON.stringify(db));
  const dirty = run();
  fs.writeFileSync(file, original);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /ledger\s+TAMPERED entry #2/);
  assert.match(dirty.stdout, /mandate\s+TAMPERED/);

  assert.equal(spawnSync(process.execPath, ['scripts/verify-ledger.js', '/nonexistent/db.json'], { encoding: 'utf8' }).status, 2);
});
