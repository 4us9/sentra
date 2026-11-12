// HTTP surface, SDK, policy-as-config, ledger export, metrics, rate limiting, CORS,
// durability and the offline verifier. Fastify app.inject() for most routes, a real
// localhost listener for the SDK. No network beyond localhost, simulated processors,
// no model.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createMemoryStore } from '@sentra/db';
import { Sentra, PaymentRefused, SentraError } from '@sentra/sdk';
import { validatePolicy, mandateFromPolicy, csvCell, queryLedger, computeMetrics, type Policy } from '@sentra/guard';
import { loadPolicies } from '../src/app.js';
import { createLimiter } from '../src/ratelimit.js';
import { createTestApp, POLICY_DIR, ok, SERVICE_DIR } from './helpers.js';

// Read when each app is built, so these apply to every app in this file.
process.env.SENTRA_GUARD_BURST = '25';
process.env.SENTRA_GUARD_RPS = '0.001';
process.env.SENTRA_OPERATOR_BURST = '1000';

type J = any;   // eslint-disable-line @typescript-eslint/no-explicit-any
const client = (app: FastifyInstance) => {
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const hasBody = method === 'POST';
    const r = await app.inject({
      method, url,
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: !hasBody ? undefined : typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
    let json: J = {};
    try { json = JSON.parse(r.body); } catch { /* not JSON */ }
    return { status: r.statusCode, body: json, text: r.body, headers: r.headers };
  };
  return {
    post: (url: string, body?: unknown, headers?: Record<string, string>) => call('POST', url, body, headers),
    get: (url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers),
    issue: async (body: unknown = {}): Promise<J> => (await call('POST', '/api/mandates', body)).body,
  };
};

describe('policy-as-config', () => {
  it('shipped policy files are valid and load', () => {
    const p = loadPolicies(POLICY_DIR);
    expect(p['grocery-run'] && p['saas-procurement']).toBeTruthy();
    for (const policy of Object.values(p)) expect(validatePolicy(policy)).toEqual([]);
  });

  it('validator is strict (typos, bad limits, missing allowlist)', () => {
    const good = loadPolicies(POLICY_DIR)['grocery-run'];
    const bad = (over: Record<string, unknown>) => validatePolicy({ ...good, ...over } as unknown as Policy).join();
    expect(bad({ perTxcap: 10 })).toMatch(/unknown field "perTxcap"/);
    expect(bad({ version: 2 })).toMatch(/version/);
    expect(bad({ perTxCap: 9999 })).toMatch(/cannot exceed/);
    expect(bad({ allowedRecipients: [] })).toMatch(/non-empty/);
    expect(bad({ allowedRecipients: ['ok', 'bаd'] })).toMatch(/invalid id/);
    expect(bad({ budgetTotal: '300' })).toMatch(/budgetTotal/);
    expect(bad({ processor: 'venmo' })).toMatch(/processor/);
    expect(bad({ outOfScope: 'allow' })).toMatch(/outOfScope/);
    expect(validatePolicy(null as unknown as Policy).join()).toMatch(/object/);
  });

  it('a bad policy file stops loading instead of falling back to defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-pol-'));
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ version: 1, name: 'bad', description: 'x', budgetTotal: -1, perTxCap: 5, allowedRecipients: ['a'] }));
    expect(() => loadPolicies(dir)).toThrow(/bad\.json: budgetTotal/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    expect(() => loadPolicies(dir)).toThrow(/not valid JSON/);
  });
});

describe('mandates over HTTP', () => {
  let app: FastifyInstance; let h: ReturnType<typeof client>; let url: string;
  beforeAll(async () => {
    ({ app } = await createTestApp());
    h = client(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());

  it('a mandate issued from a policy carries its limits, name and expiry', async () => {
    const { mandate } = await h.issue({ policy: 'saas-procurement', processor: 'stripe' });
    expect(mandate.policy).toBe('saas-procurement');
    expect(mandate.budgetTotal).toBe(2000);
    expect(mandate.outOfScope).toBe('block');
    expect(mandate.processor).toBe('stripe');
    expect(mandate.sealValid).toBe(true);
    const ttl = (Date.parse(mandate.expiresAt) - Date.now()) / 3600e3;
    expect(ttl).toBeGreaterThan(71);
    expect(ttl).toBeLessThanOrEqual(72);
    expect(mandateFromPolicy(loadPolicies(POLICY_DIR)['grocery-run'], 0).expiresAt).toBe(new Date(24 * 3600e3).toISOString());
    expect((await h.post('/api/mandates', { policy: 'no-such-policy' })).status).toBe(400);
    expect((await h.post('/api/mandates', { policy: 'grocery-run', processor: 'venmo' })).status).toBe(400);
  });

  it('limits and ids cannot be set per mandate; an existing mandate cannot be replaced', async () => {
    const first = await h.issue({ policy: 'grocery-run' });
    const hijack = await h.post('/api/mandates', { policy: 'grocery-run', id: first.mandate.id, budgetTotal: 1e9 });
    expect(hijack.status).toBe(400);
    expect(hijack.body.error).toMatch(/not settable per mandate: id, budgetTotal/);
    const still = await new Sentra({ url, agentToken: first.agentToken }).mandate();
    expect(still.id).toBe(first.mandate.id);
    expect(still.budgetTotal).toBe(300);
    const named = await h.issue({ policy: 'grocery-run', user: 'alice' });
    expect(named.mandate.user).toBe('alice');
    expect(named.mandate.id).not.toBe(first.mandate.id);
  });

  it('freeze and reinstate: the kill switch refuses payments, reinstating restores them', async () => {
    const { mandate, agentToken } = await h.issue({ policy: 'grocery-run' });
    const auth = { authorization: `Bearer ${agentToken}` };
    expect((await h.post(`/api/mandates/${mandate.id}/freeze`)).body.status).toBe('frozen');
    const refused = await h.post('/guard', ok, auth);
    expect(refused.body.verdict).toBe('BLOCK');
    expect(refused.body.reasons.some((r: J) => r.check === 'mandate_active')).toBe(true);
    const back = await h.post(`/api/mandates/${mandate.id}/reinstate`);
    expect(back.body.status).toBe('active');
    expect(back.body.tokenHash).toBeUndefined();
    expect((await h.post('/guard', ok, auth)).body.verdict).toBe('ALLOW');
    expect((await h.post('/api/mandates/nope/freeze')).status).toBe(404);
  });

  it('reviews: a held payment is approved or denied over HTTP, once', async () => {
    const { agentToken } = await h.issue({ policy: 'grocery-run' });
    const auth = { authorization: `Bearer ${agentToken}` };
    const held = (await h.post('/guard', { ...ok, purpose: 'wireless headphones' }, auth)).body;
    expect(held.verdict).toBe('REVIEW');
    const approved = await h.post(`/api/reviews/${held.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.verdict).toBe('ALLOW');
    expect(approved.body.resolves).toBe(held.id);
    expect((await h.post(`/api/reviews/${held.id}/approve`)).status).toBe(409);
    const held2 = (await h.post('/guard', { ...ok, purpose: 'wireless headphones' }, auth)).body;
    expect((await h.post(`/api/reviews/${held2.id}/deny`)).body.verdict).toBe('BLOCK');
    expect((await h.post(`/api/reviews/${held2.id}/frobnicate`)).status).toBe(400);
    expect((await h.post('/api/reviews/dec_missing/approve')).status).toBe(404);
  });

  it('agent endpoints: bad or missing token is 401', async () => {
    expect((await h.post('/guard', ok)).status).toBe(401);
    expect((await h.post('/guard', ok, { authorization: 'Bearer sat_nope' })).status).toBe(401);
    expect((await h.get('/guard/mandate', { authorization: 'Bearer sat_nope' })).status).toBe(401);
  });

  it('sdk: guard, guardOrThrow, mandate, protect', async () => {
    const { mandate, agentToken } = await h.issue({ policy: 'grocery-run' });
    const sentra = new Sentra({ url, agentToken });
    const d = await sentra.guard(ok);
    expect(d.verdict).toBe('ALLOW');
    expect(d.decidedBy).toBeNull();
    expect(d.paymentId).toMatch(/^SIM-PAYPAL-/);
    expect((await sentra.mandate()).id).toBe(mandate.id);

    const blocked = await sentra.guard({ ...ok, amount: 5000, recipient: 'wallet_unknown_0xABCD' });
    expect(blocked.verdict).toBe('BLOCK');
    expect(blocked.decidedBy).toEqual({ layer: 'rule', check: 'per_tx_cap' });

    await expect(sentra.guardOrThrow({ ...ok, purpose: 'gift card' })).rejects.toSatisfy(
      (e: unknown) => e instanceof PaymentRefused && e.verdict === 'BLOCK' && e.decision.decidedBy!.layer === 'intent');

    let ran = 0;
    const pay = sentra.protect(async (payment, decision) => { ran++; return `${payment.amount}:${decision.verdict}`; });
    expect(await pay({ ...ok, amount: 5 })).toBe('5:ALLOW');
    await expect(pay({ ...ok, amount: -5 })).rejects.toBeInstanceOf(PaymentRefused);
    expect(ran, 'the wrapped function must not run for a refused payment').toBe(1);
  });

  it('sdk: bad token is a SentraError 401; missing token is refused up front', async () => {
    await expect(new Sentra({ url, agentToken: 'sat_nope' }).guard(ok)).rejects.toSatisfy((e: unknown) => e instanceof SentraError && e.status === 401);
    expect(() => new Sentra({ url } as never)).toThrow(SentraError);
  });
});

describe('HTTP hardening', () => {
  it('security headers, malformed JSON, oversized body, no stack traces', async () => {
    const { app } = await createTestApp();
    const h = client(app);
    const page = await h.get('/');
    expect(page.status).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toMatch(/script-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
    expect(csp.split('script-src')[1].split(';')[0]).not.toMatch(/unsafe-inline/);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-powered-by']).toBeUndefined();

    const { agentToken } = await h.issue();
    const auth = { authorization: `Bearer ${agentToken}` };
    const bad = await h.post('/guard', '{not json', auth);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'malformed request' });
    const big = await h.post('/guard', { ...ok, purpose: 'x'.repeat(20000) }, auth);
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'request too large' });
    expect(bad.text + big.text).not.toMatch(/at \w+.*\.(ts|js):\d+/);
    await app.close();
  });

  it('the dashboard API never exposes token hashes or seals', async () => {
    const { app } = await createTestApp();
    const h = client(app);
    await h.issue();
    const state = JSON.parse((await h.get('/api/state')).text);
    expect(state.mandates.length).toBeGreaterThan(0);
    for (const m of state.mandates) { expect(m.tokenHash).toBeUndefined(); expect(m.seal).toBeUndefined(); }
    expect(/sat_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(state))).toBe(false);
    await app.close();
  });

  it('/guard is rate limited per agent token; other agents are unaffected', async () => {
    const { app } = await createTestApp();
    const h = client(app);
    const a = await h.issue(); const b = await h.issue();
    const hit = (tok: string) => h.post('/guard', { ...ok, amount: 1 }, { authorization: `Bearer ${tok}` });
    const out: number[] = [];
    for (let i = 0; i < 30; i++) out.push((await hit(a.agentToken)).status);
    expect(out.filter((s) => s === 200)).toHaveLength(25);
    expect(out.filter((s) => s === 429)).toHaveLength(5);
    const limited = await hit(a.agentToken);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await hit(b.agentToken)).status).toBe(200);
    await app.close();
  });

  it('ratelimit: bucket refills over time', () => {
    let t = 0;
    const l = createLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    expect(l.take('k').ok).toBe(true);
    expect(l.take('k').ok).toBe(true);
    expect(l.take('k').ok).toBe(false);
    t += 1000;
    expect(l.take('k').ok).toBe(true);
    expect(l.take('other').ok).toBe(true);
  });

  it('CORS: the configured web origin may preflight, other origins get no allow header', async () => {
    const { app } = await createTestApp({ corsOrigins: ['http://localhost:3100'] });
    const preflight = (origin: string) => app.inject({
      method: 'OPTIONS', url: '/api/mandates',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-sentra-admin' },
    });
    const good = await preflight('http://localhost:3100');
    expect(good.statusCode).toBeLessThan(300);
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:3100');
    const evil = await preflight('http://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('a store that is not durable pauses payments: POST /guard is 503 and /health says so', async () => {
    const base = createMemoryStore();
    const store = { ...base, health: () => ({ ...base.health(), durable: false, lastError: 'disk full' }) };
    const { app } = await createTestApp({ store });
    const h = client(app);
    const { agentToken } = await h.issue();
    const r = await h.post('/guard', ok, { authorization: `Bearer ${agentToken}` });
    expect(r.status).toBe(503);
    expect(base.listDecisions().filter((d) => d.kind === 'payment')).toHaveLength(0);
    const health = await h.get('/health');
    expect(health.body.ok).toBe(false);
    expect(health.body.storage.durable).toBe(false);
    await app.close();
  });
});

describe('ledger, export and metrics', () => {
  let app: FastifyInstance; let h: ReturnType<typeof client>;
  let paypalMandateId: string;
  beforeAll(async () => {
    ({ app } = await createTestApp());
    h = client(app);
    const p = await h.issue({ processor: 'paypal' });
    const s = await h.issue({ processor: 'stripe' });
    paypalMandateId = p.mandate.id;
    const send = (tok: string, body: unknown) => h.post('/guard', body, { authorization: `Bearer ${tok}` });
    await send(p.agentToken, ok);
    await send(s.agentToken, ok);
    await send(p.agentToken, { ...ok, purpose: 'gift card' });
    await send(s.agentToken, { ...ok, amount: -1 });
    await send(s.agentToken, { ...ok, purpose: '=HYPERLINK("http://evil.example","click")' });
  });
  afterAll(() => app.close());

  it('query by verdict, layer, processor and text; CSV export', async () => {
    const q = async (qs: string): Promise<J> => JSON.parse((await h.get('/api/ledger?' + qs)).text);
    expect((await q('')).total).toBe(7);                        // 5 payments + 2 mandate-issued events
    expect((await q('kind=payment')).total).toBe(5);
    const issued = (await q('kind=event')).entries;
    expect(issued).toHaveLength(2);
    expect(issued[0].reasons[0].check).toBe('mandate_issued');
    expect(issued[0].reasons[0].detail).toMatch(/from policy "grocery-run".*rail paypal/);
    expect((await q('verdict=ALLOW')).total).toBe(2);
    expect((await q('verdict=BLOCK,REVIEW')).total).toBe(3);
    expect((await q('layer=intent')).total).toBe(2);
    expect((await q('layer=schema')).entries[0].decidedBy.check).toBe('amount_format');
    expect((await q('processor=stripe&kind=payment')).total).toBe(3);
    expect((await q('q=gift')).total).toBe(1);
    expect((await q(`mandate=${paypalMandateId}&kind=payment`)).total).toBe(2);
    expect((await q('limit=2&offset=6')).entries).toHaveLength(1);
    expect((await q('')).audit.ok).toBe(true);

    const csv = await h.get('/api/ledger?format=csv');
    expect(String(csv.headers['content-type'])).toMatch(/text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^seq,time,decision_id,.*decided_by_layer,decided_by_check,.*prev_hash,hash$/);
    expect(csv.text.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), 'formula cell must be neutralised').toBe(true);
  });

  it('csv cells are escaped and formula-safe', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-150')).toBe("'-150");
    expect(csvCell(-150), 'real numbers stay numbers').toBe('-150');
    expect(csvCell(null)).toBe('');
  });

  it('JSON and Prometheus metrics views agree with the ledger', async () => {
    const m = JSON.parse((await h.get('/api/metrics')).text);
    expect(m.decisions).toBe(5);
    expect(m.byVerdict).toEqual({ ALLOW: 2, BLOCK: 3, REVIEW: 0, ERROR: 0 });
    expect(m.blockRate).toBe(0.6);
    expect(m.spendByProcessor).toEqual({ paypal: 40, stripe: 40 });
    expect(m.stoppedByLayer).toEqual({ intent: 2, schema: 1 });
    expect(m.blockedValue).toBe(80);
    expect(m.latencyMs.p95).toBeGreaterThanOrEqual(m.latencyMs.p50);

    const prom = (await h.get('/metrics')).text;
    expect(prom).toMatch(/sentra_decisions_total\{verdict="BLOCK"\} 3/);
    expect(prom).toMatch(/sentra_spend_total\{processor="stripe"\} 40/);
    expect(prom).toMatch(/sentra_ledger_intact 1/);
    expect(prom).toMatch(/sentra_decision_latency_ms\{quantile="0\.95"\}/);
  });

  it('empty ledger does not divide by zero', () => {
    const m = computeMetrics([], []);
    expect(m.blockRate).toBe(0);
    expect(m.latencyMs.p95).toBe(0);
    expect(queryLedger([], {}).total).toBe(0);
  });
});

describe('offline verifier (dist/scripts/verify-ledger.js)', () => {
  it('exits 0 on an intact ledger and 1 after tampering; 2 when unreadable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-verify-'));
    const file = path.join(dir, 'db.json');
    const { app } = await createTestApp({ store: createMemoryStore({ file }) });
    const h = client(app);
    const { agentToken } = await h.issue();
    const auth = { authorization: `Bearer ${agentToken}` };
    await h.post('/guard', ok, auth);
    await h.post('/guard', { ...ok, amount: 5000, recipient: 'wallet_unknown_0xABCD' }, auth);
    await app.close();

    const script = path.join(SERVICE_DIR, 'dist', 'scripts', 'verify-ledger.js');
    expect(fs.existsSync(script), 'run `pnpm build` before the tests').toBe(true);
    const run = (f: string) => spawnSync(process.execPath, [script, f], {
      encoding: 'utf8', cwd: SERVICE_DIR,
      env: { ...process.env, SENTRA_SECRET: 'test-secret', SENTRA_NO_DOTENV: '1', SENTRA_DATA_DIR: dir },
    });
    const clean = run(file);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toMatch(/ledger\s+OK/);

    const original = fs.readFileSync(file, 'utf8');
    const db = JSON.parse(original);
    const i = db.decisions.findIndex((d: J) => d.verdict === 'BLOCK');
    expect(i).toBeGreaterThanOrEqual(0);
    db.decisions[i].verdict = 'ALLOW';                                   // rewrite a BLOCK
    (Object.values(db.mandates)[0] as J).budgetTotal = 1e9;              // and raise a limit
    fs.writeFileSync(file, JSON.stringify(db));
    const dirty = run(file);
    fs.writeFileSync(file, original);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toMatch(new RegExp(`ledger\\s+TAMPERED entry #${i} `));
    expect(dirty.stdout).toMatch(/mandate\s+TAMPERED/);

    expect(run(file).status).toBe(0);
    expect(run('/nonexistent/db.json').status).toBe(2);
  });
});
