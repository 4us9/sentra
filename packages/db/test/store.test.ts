import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chainEntry, GENESIS, verifyChain, type Decision, type Mandate } from '@sentra/guard';
import { createMemoryStore, createPostgresStore, readPostgresLedger, type Store } from '../src/index.js';

const mandate = (id: string, tokenHash: string): Mandate => ({
  id, user: 'u', policy: null, description: 'd', scope: ['groceries'], processor: 'paypal', currency: 'USD',
  budgetTotal: 300, perTxCap: 75, allowedRecipients: ['merchant_a'], velocityLimit: { count: 6, windowSec: 60 },
  breaker: { blocks: 5, windowSec: 120 }, outOfScope: 'review', expiresAt: '2030-01-01T00:00:00.000Z',
  tokenHash, createdAt: '2026-11-12T00:00:00.000Z', spent: 0, status: 'active', frozenReason: null,
  breakerResetAt: null, seal: 'seal',
});

function decision(store: Store, mandateId: string, n: number): Decision {
  const last = store.lastDecision();
  return chainEntry({
    id: `dec_${n}`, seq: last ? last.seq + 1 : 0, kind: 'payment', mandateId, processor: 'paypal',
    request: { amount: 10 + n, currency: 'USD', recipient: 'merchant_a', purpose: 'p' }, verdict: 'ALLOW',
    reasons: [], riskScore: 0, intentSource: 'fallback', decidedBy: null, createdAt: new Date(1_800_000_000_000 + n).toISOString(),
    payment: null, paymentId: null, resolves: null, effects: [], latencyMs: n / 3,
  }, last ? last.hash : GENESIS) as Decision;
}

function contract(name: string, open: () => Promise<Store>, reopen: () => Promise<Store>) {
  describe(name, () => {
    it('indexes by token, keeps the chain, survives a reopen byte for byte', async () => {
      const s = await open();
      s.saveMandate(mandate('m1', 'h1'));
      for (let i = 0; i < 5; i++) s.appendDecision(decision(s, 'm1', i));
      await s.flush();
      expect(s.mandateByTokenHash('h1')?.id).toBe('m1');
      expect(s.decisionsFor('m1')).toHaveLength(5);
      expect(verifyChain(s.listDecisions()).ok).toBe(true);
      await s.close();

      const r = await reopen();
      expect(verifyChain(r.listDecisions())).toMatchObject({ ok: true, length: 5 });
      expect(r.getMandate('m1')).toEqual(mandate('m1', 'h1'));
      expect(r.findDecision('dec_3')?.latencyMs).toBeCloseTo(1, 5);
      await r.close();
    });

    it("a replaced mandate's old token stops resolving", async () => {
      const s = await reopen();
      s.saveMandate(mandate('m1', 'h2'));
      expect(s.mandateByTokenHash('h1')).toBeNull();
      expect(s.mandateByTokenHash('h2')?.id).toBe('m1');
      await s.flush(); await s.close();
    });

    it('returns copies: mutating a read does not change the store', async () => {
      const s = await reopen();
      const m = s.getMandate('m1')!;
      m.spent = 999;
      expect(s.getMandate('m1')!.spent).toBe(0);
      await s.close();
    });
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-db-'));
const file = path.join(dir, 'db.json');
contract('file store', async () => createMemoryStore({ file }), async () => createMemoryStore({ file }));

// Postgres runs only when a throwaway database is provided. It is wiped.
const PG = process.env.SENTRA_TEST_DATABASE_URL;
describe.skipIf(!PG)('postgres store', () => {
  beforeAll(async () => { const s = await createPostgresStore({ url: PG! }); s.reset(); await s.flush(); await s.close(); });
  contract('postgres contract', () => createPostgresStore({ url: PG! }), () => createPostgresStore({ url: PG! }));

  it('a second writer is refused while the first holds the lock', async () => {
    const a = await createPostgresStore({ url: PG! });
    await expect(createPostgresStore({ url: PG! })).rejects.toThrow(/writer lock/);
    await a.close();
  });
  it('the verifier reader works while a writer holds the lock', async () => {
    const writer = await createPostgresStore({ url: PG! });
    const ledger = await readPostgresLedger({ url: PG! });
    expect(Array.isArray(ledger.decisions)).toBe(true);
    expect(Array.isArray(ledger.mandates)).toBe(true);
    await writer.close();
  });
  afterAll(async () => {});
});
