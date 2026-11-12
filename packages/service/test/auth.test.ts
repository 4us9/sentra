// Operator authentication: open demo mode, the root credential, scoped API keys,
// and the rule that an agent token is never an operator credential.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Store } from '@sentra/db';
import { mintApiKey } from '../src/auth.js';
import { createTestApp, ok } from './helpers.js';

type J = any;   // eslint-disable-line @typescript-eslint/no-explicit-any
const ROOT = 'root-token-for-tests';

let app: FastifyInstance; let store: Store;
beforeEach(async () => { ({ app, store } = await createTestApp()); });
afterEach(async () => { delete process.env.SENTRA_ADMIN_TOKEN; await app.close(); });

const call = async (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, body: unknown = {}) => {
  const r = await app.inject({ method, url, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, payload: method === 'POST' ? JSON.stringify(body) : undefined });
  let json: J = {};
  try { json = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: json, text: r.body };
};
const root = { 'x-sentra-admin': ROOT };
const mint = async (body: unknown) => (await call('POST', '/api/keys', root, body)).body as J;

describe('operator auth', () => {
  it('open demo mode: with no root token and no keys, operator routes need nothing', async () => {
    expect((await call('POST', '/api/mandates')).status).toBe(200);
    expect((await call('GET', '/health')).body.operatorAuth).toBe(false);
  });

  it('with SENTRA_ADMIN_TOKEN set: 401 without the credential, 401 with a wrong one, 200 with it', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    expect((await call('POST', '/api/mandates')).status).toBe(401);
    expect((await call('POST', '/api/mandates', { 'x-sentra-admin': 'wrong' })).status).toBe(401);
    expect((await call('POST', '/api/mandates', root)).status).toBe(200);
    expect((await call('GET', '/health')).body.operatorAuth).toBe(true);
    // every operator write is protected, not just issuing
    expect((await call('POST', '/api/mandates/x/freeze')).status).toBe(401);
    expect((await call('POST', '/api/mandates/x/reinstate')).status).toBe(401);
    expect((await call('POST', '/api/reviews/x/approve')).status).toBe(401);
    expect((await call('POST', '/api/demo/reset')).status).toBe(401);
  });

  it('POST /api/keys mints sk_sentra_ keys (root only); 403 when no root token is configured', async () => {
    expect((await call('POST', '/api/keys', {}, { label: 'ci' })).status).toBe(403);   // open demo: cannot mint
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    const out = await mint({ label: 'ci' });
    expect(out.key).toMatch(/^sk_sentra_/);
    expect(out.record.label).toBe('ci');
    expect(out.record.scopes).toEqual(['admin', 'read']);
    expect(out.record.keyHash).toBeUndefined();
    expect((await call('POST', '/api/keys', {}, { label: 'x' })).status).toBe(401);    // no credential
    expect((await call('POST', '/api/keys', root, { scopes: ['superuser'] })).status).toBe(400);
    expect((await call('POST', '/api/keys', root, { scopes: [] })).status).toBe(400);
  });

  it('a non-root key cannot mint, list or revoke keys', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    const { key, record } = await mint({ label: 'ops' });
    const k = { 'x-sentra-admin': key };
    expect((await call('POST', '/api/keys', k, { label: 'child' })).status).toBe(403);
    expect((await call('GET', '/api/keys', k)).status).toBe(403);
    expect((await call('POST', `/api/keys/${record.id}/revoke`, k)).status).toBe(403);
  });

  it('a minted key works via x-sentra-admin and via Authorization: Bearer, and is named on the ledger', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    const { key } = await mint({ label: 'alice-laptop' });
    const viaHeader = await call('POST', '/api/mandates', { 'x-sentra-admin': key });
    expect(viaHeader.status).toBe(200);
    const viaBearer = await call('POST', '/api/mandates', { authorization: `Bearer ${key}` });
    expect(viaBearer.status).toBe(200);
    const ledger = JSON.parse((await call('GET', '/api/ledger?kind=event')).text);
    expect(ledger.entries[0].reasons[0].detail).toMatch(/issued by alice-laptop/);
  });

  it('a read-scoped key gets 403 on admin routes', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    const { key } = await mint({ label: 'viewer', scopes: ['read'] });
    const k = { 'x-sentra-admin': key };
    expect((await call('POST', '/api/mandates', k)).status).toBe(403);
    expect((await call('POST', '/api/mandates/x/freeze', k)).status).toBe(403);
    expect((await call('POST', '/api/reviews/x/approve', k)).status).toBe(403);
    expect((await call('POST', '/api/demo/reset', k)).status).toBe(403);
    expect((await call('GET', '/api/ledger', k)).status).toBe(200);
  });

  it('a revoked key gets 401', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    const { key, record } = await mint({ label: 'temp' });
    const k = { 'x-sentra-admin': key };
    expect((await call('POST', '/api/mandates', k)).status).toBe(200);
    expect((await call('POST', `/api/keys/${record.id}/revoke`, root)).status).toBe(200);
    expect((await call('POST', '/api/mandates', k)).status).toBe(401);
    expect((await call('POST', '/api/mandates', { authorization: `Bearer ${key}` })).status).toBe(401);
    expect((await call('POST', '/api/keys/key_nope/revoke', root)).status).toBe(404);
  });

  it('an agent token (sat_...) is never accepted as an operator credential', async () => {
    // issued while the demo is still open, then the operator locks it down
    const { agentToken } = (await call('POST', '/api/mandates')).body as J;
    expect(agentToken).toMatch(/^sat_/);
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    expect((await call('POST', '/api/mandates', { 'x-sentra-admin': agentToken })).status).toBe(401);
    expect((await call('POST', '/api/mandates', { authorization: `Bearer ${agentToken}` })).status).toBe(401);
    expect((await call('POST', '/api/mandates/x/freeze', { authorization: `Bearer ${agentToken}` })).status).toBe(401);
    // and the operator token is not an agent token either
    expect((await call('POST', '/guard', { authorization: `Bearer ${ROOT}` }, ok)).status).toBe(401);
  });

  it('GET /api/keys lists keys and never returns keyHash', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    await mint({ label: 'a' });
    await mint({ label: 'b', scopes: ['read'] });
    const r = await call('GET', '/api/keys', root);
    expect(r.status).toBe(200);
    expect(r.body.keys).toHaveLength(2);
    for (const k of r.body.keys) expect(k.keyHash).toBeUndefined();
    expect(r.text).not.toMatch(/keyHash|sk_sentra_/);
    expect(store.listApiKeys().every((k) => k.keyHash.length === 64)).toBe(true);
  });

  it('once any API key exists, the open demo mode closes', async () => {
    mintApiKey(store, 'first', ['admin']);
    expect((await call('POST', '/api/mandates')).status).toBe(401);
    expect((await call('GET', '/health')).body.operatorAuth).toBe(true);
  });

  it('keys are stored hashed only', async () => {
    process.env.SENTRA_ADMIN_TOKEN = ROOT;
    const { key } = await mint({ label: 'h' });
    expect(JSON.stringify(store.listApiKeys()).includes(key)).toBe(false);
  });
});

