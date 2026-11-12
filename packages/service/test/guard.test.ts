// The guard chokepoint end to end (simulated processors, no model, no network):
// auth, atomicity under concurrency, idempotency, circuit breaker, human review,
// reservations, tamper evidence, restart persistence and processor routing.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMandate, decide, sealValid, hashToken, type PaymentProcessor } from '@sentra/guard';
import { createMemoryStore } from '@sentra/db';
import { minorUnits } from '../src/processors/stripe.js';
import { createEnv, fakeProcessor, high, low, med, none, now, ok, sleep, wide, type D } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-guard-'));

describe('guard: auth, debit and token scoping', () => {
  it('no token / wrong token -> 401, nothing recorded', async () => {
    const { guard, issue, store } = createEnv();
    issue();
    expect((await guard.guardPayment('', ok)).status).toBe(401);
    expect((await guard.guardPayment('sat_not-a-real-token', ok)).status).toBe(401);
    expect(store.listDecisions()).toHaveLength(0);
  });

  it('ALLOW executes an order and debits; BLOCK does neither', async () => {
    const { store, issue, pay } = createEnv();
    const { id, token } = issue();
    const a = await pay(token, ok);
    expect(a.verdict).toBe('ALLOW');
    expect(a.paymentId).toMatch(/^SIM-PAYPAL-/);
    expect(store.getMandate(id)!.spent).toBe(40);
    const b = await pay(token, { amount: 5000, recipient: 'wallet_unknown_0xABCD', purpose: 'urgent transfer' });
    expect(b.verdict).toBe('BLOCK');
    expect(b.paymentId).toBeNull();
    expect(store.getMandate(id)!.spent).toBe(40);
  });

  it('an agent token only ever reaches its own mandate', async () => {
    const { store, issue, pay } = createEnv();
    const rich = issue({ budgetTotal: 100000, perTxCap: 50000 });
    const poor = issue();
    const d = await pay(poor.token, { ...ok, amount: 5000, mandateId: rich.id });
    expect(d.mandateId).toBe(poor.id);
    expect(d.verdict).toBe('BLOCK');
    expect(store.getMandate(rich.id)!.spent).toBe(0);
  });

  it('mandateForToken resolves by hash and rejects unknown tokens', () => {
    const { guard, issue } = createEnv();
    const { id, token } = issue();
    expect(guard.mandateForToken(token)!.id).toBe(id);
    expect(guard.mandateForToken('sat_nope')).toBeNull();
    expect(guard.mandateForToken('')).toBeNull();
    expect(guard.mandateForToken(null)).toBeNull();
  });
});

describe('guard: concurrency', () => {
  it('double-spend race: two concurrent $150 against a $200 budget -> exactly one ALLOW', async () => {
    const { store, issue, pay } = createEnv();
    const { id, token } = issue({ budgetTotal: 200, perTxCap: 150 });
    const out = await Promise.all([1, 2].map(() => pay(token, { ...ok, amount: 150 })));
    expect(out.map((d) => d.verdict).sort()).toEqual(['ALLOW', 'BLOCK']);
    expect(store.getMandate(id)!.spent).toBe(150);
  });

  it('25 concurrent payments can never overspend the budget', async () => {
    const { store, issue, pay } = createEnv();
    const { id, token } = issue({ budgetTotal: 200, perTxCap: 75, velocityLimit: { count: 1000, windowSec: 60 }, breaker: { blocks: 1000, windowSec: 60 } });
    const out = await Promise.all(Array.from({ length: 25 }, () => pay(token, { ...ok, amount: 20 })));
    const allows = out.filter((d) => d.verdict === 'ALLOW').length;
    const spent = store.getMandate(id)!.spent;
    expect(allows).toBeGreaterThanOrEqual(1);
    expect(spent).toBe(allows * 20);
    expect(spent, `spent ${spent} exceeds budget`).toBeLessThanOrEqual(200);
  });
});

describe('guard: idempotency', () => {
  it('a retried payment is charged once', async () => {
    const { store, issue, pay } = createEnv();
    const { id, token } = issue();
    const first = await pay(token, { ...ok, idempotencyKey: 'order-7781' });
    const again = await pay(token, { ...ok, idempotencyKey: 'order-7781' });
    expect(again.id).toBe(first.id);
    expect(again.replayed).toBe(true);
    expect(store.getMandate(id)!.spent).toBe(40);
    expect(store.listDecisions().filter((d) => d.kind === 'payment')).toHaveLength(1);
  });

  it('the same key sent concurrently is executed once', async () => {
    const { store, guard, issue } = createEnv();
    const { id, token } = issue({ ...wide });
    const proc = fakeProcessor({ delay: 30 });
    const out = await Promise.all([1, 2, 3].map(() =>
      guard.guardPayment(token, { ...ok, idempotencyKey: 'order-42' }, { semantic: low, processor: proc }).then((r) => r.body as D)));
    expect(proc.calls).toHaveLength(1);
    expect(new Set(out.map((d) => d.id)).size).toBe(1);
    expect(store.getMandate(id)!.spent).toBe(40);
    expect(proc.calls[0].idempotencyKey, 'the decision id is the processor idempotency key').toBe(out[0].id);
  });

  it('reusing a key for a different payment is refused, not silently replayed', async () => {
    const { store, guard, issue } = createEnv();
    const { id, token } = issue({ ...wide });
    const proc = fakeProcessor({ delay: 30 });
    const first = guard.guardPayment(token, { ...ok, idempotencyKey: 'k1' }, { semantic: low, processor: proc });
    await sleep(5);
    const inFlightClash = await guard.guardPayment(token, { ...ok, amount: 70, idempotencyKey: 'k1' }, { semantic: low, processor: proc });
    expect(inFlightClash.status).toBe(409);
    await first;
    const settledClash = await guard.guardPayment(token, { ...ok, recipient: 'merchant_greengrocer', idempotencyKey: 'k1' }, { semantic: low, processor: proc });
    expect(settledClash.status).toBe(409);
    const same = await guard.guardPayment(token, { ...ok, amount: '40.00', idempotencyKey: 'k1' }, { semantic: low, processor: proc });
    expect(same.status, 'same payment, different spelling of the amount').toBe(200);
    expect((same.body as D).replayed).toBe(true);
    expect(proc.calls).toHaveLength(1);
    expect(store.getMandate(id)!.spent).toBe(40);
  });

  it('a joined request that failed is not labelled as a replay of success, but is honestly labelled a replay', async () => {
    const { guard, issue } = createEnv();
    const { token } = issue({ ...wide });
    const boom: PaymentProcessor = {
      name: 'fake', label: 'Fake', mode: () => 'simulated',
      createPayment: async () => { await sleep(20); throw new Error('down'); },
    };
    const [a, b] = await Promise.all([1, 2].map(() => guard.guardPayment(token, { ...ok, idempotencyKey: 'k9' }, { semantic: low, processor: boom })));
    expect((a.body as D).verdict).toBe('ERROR');
    expect((b.body as D).id).toBe((a.body as D).id);
    expect((b.body as D).replayed).toBe(true);       // same recorded decision, honestly labelled
    expect(b.status).toBe(200);
  });
});

describe('guard: circuit breaker', () => {
  it('freezes the mandate after 3 blocks; reinstating clears it', async () => {
    const { store, guard, issue, pay } = createEnv();
    const { id, token } = issue({ breaker: { blocks: 3, windowSec: 120 } });
    const bad = { ...ok, recipient: 'wallet_unknown' };
    await pay(token, bad);
    await pay(token, bad);
    expect(store.getMandate(id)!.status).toBe('active');
    const third = await pay(token, bad);
    expect(third.effects).toEqual(['mandate_frozen']);
    expect(store.getMandate(id)!.status).toBe('frozen');
    const legit = await pay(token, ok);                 // even a clean payment is refused now
    expect(legit.verdict).toBe('BLOCK');
    expect(legit.reasons.some((r) => r.check === 'mandate_active' && r.result === 'FAIL')).toBe(true);
    await guard.setFrozen(id, false);
    expect((await pay(token, ok)).verdict).toBe('ALLOW');
    expect((await pay(token, bad)).verdict).toBe('BLOCK');   // one new block does not re-freeze
    expect(store.getMandate(id)!.status).toBe('active');
  });

  it('setFrozen on an unknown mandate is a 404 and writes nothing', async () => {
    const { store, guard } = createEnv();
    const r = await guard.setFrozen('nope', true);
    expect(r.status).toBe(404);
    expect(store.listDecisions()).toHaveLength(0);
  });

  it('freeze and reinstate are on the ledger as events', async () => {
    const { store, guard, issue } = createEnv();
    const { id } = issue();
    await guard.setFrozen(id, true, { operator: 'alice' });
    await guard.setFrozen(id, false, { operator: 'alice' });
    const events = store.decisionsFor(id).filter((d) => d.kind === 'event');
    expect(events.map((e) => e.reasons[0].check)).toEqual(['kill_switch', 'reinstate']);
    expect(events[0].reasons[0].detail).toMatch(/frozen by alice/);
    expect(guard.auditStatus().ok).toBe(true);
  });
});

describe('guard: human review', () => {
  it('REVIEW holds without paying; approve executes; cannot be resolved twice', async () => {
    const { store, guard, issue, pay } = createEnv();
    const { id, token } = issue();
    const held = await pay(token, { ...ok, purpose: 'wireless headphones' }, none);
    expect(held.verdict).toBe('REVIEW');
    expect(store.getMandate(id)!.spent).toBe(0);
    const res = (await guard.resolveReview(held.id, 'approve')).body as D;
    expect(res.verdict).toBe('ALLOW');
    expect(res.resolves).toBe(held.id);
    expect(store.getMandate(id)!.spent).toBe(40);
    expect((await guard.resolveReview(held.id, 'approve')).status).toBe(409);
    expect(store.getMandate(id)!.spent).toBe(40);
  });

  it('deny resolves a REVIEW without paying', async () => {
    const { store, guard, issue, pay } = createEnv();
    const { id, token } = issue();
    const held = await pay(token, { ...ok, purpose: 'wireless headphones' }, none);
    expect(((await guard.resolveReview(held.id, 'deny')).body as D).verdict).toBe('BLOCK');
    expect(store.getMandate(id)!.spent).toBe(0);
  });

  it('approving on stale state is refused (budget was spent while the payment was held)', async () => {
    const { store, guard, issue, pay } = createEnv();
    const { id, token } = issue({ budgetTotal: 100, perTxCap: 75 });
    const held = await pay(token, { ...ok, amount: 60, purpose: 'wireless headphones' }, none);
    await pay(token, { ...ok, amount: 60 });
    const res = (await guard.resolveReview(held.id, 'approve')).body as D;
    expect(res.verdict).toBe('BLOCK');
    expect(res.reasons.some((r) => r.check === 'stale_approval')).toBe(true);
    expect(store.getMandate(id)!.spent).toBe(60);
  });

  it('two concurrent approvals of one held payment execute it once', async () => {
    const { store, guard, issue, pay } = createEnv();
    const { id, token } = issue({ ...wide });
    const held = await pay(token, { ...ok, purpose: 'wireless headphones' }, none);
    const proc = fakeProcessor({ delay: 30 });
    const out = await Promise.all([1, 2].map(() => guard.resolveReview(held.id, 'approve', { processor: proc })));
    expect(out.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(proc.calls).toHaveLength(1);
    expect(store.getMandate(id)!.spent).toBe(40);
  });

  it('unknown or non-held decisions are 404; bad actions are 400', async () => {
    const { guard, issue, pay } = createEnv();
    const { token } = issue();
    expect((await guard.resolveReview('dec_nope', 'approve')).status).toBe(404);
    const allowed = await pay(token, ok);
    expect((await guard.resolveReview(allowed.id, 'approve')).status).toBe(404);   // only REVIEW can be resolved
    const held = await pay(token, { ...ok, purpose: 'wireless headphones' }, none);
    expect((await guard.resolveReview(held.id, 'maybe')).status).toBe(400);
  });
});

describe('guard: tamper evidence', () => {
  it('tampering with the stored mandate or the ledger is caught', async () => {
    const { store, guard, issue, pay } = createEnv();
    const { id, token } = issue();
    await pay(token, ok);
    await pay(token, { ...ok, amount: 5000 });
    expect(guard.auditStatus().ok).toBe(true);
    store._tamper((s) => { s.decisions[1].verdict = 'ALLOW'; });       // rewrite history
    const status = guard.auditStatus();
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.brokenAt).toBe(1);
    store._tamper((s) => { s.mandates[id].budgetTotal = 999999; s.mandates[id].perTxCap = 999999; });
    const d = await pay(token, { ...ok, amount: 5000 });
    expect(d.verdict).toBe('BLOCK');
    expect(d.reasons.some((r) => r.check === 'mandate_integrity' && r.result === 'FAIL')).toBe(true);
  });
});

describe('guard: reservation (reserve -> execute -> commit / release)', () => {
  it('processor calls overlap (lock not held during execution) yet budget is never oversold', async () => {
    const { store, guard, issue } = createEnv();
    const { id, token } = issue({ budgetTotal: 100, perTxCap: 40, ...wide });
    const proc = fakeProcessor({ delay: 30 });
    const out = await Promise.all(Array.from({ length: 5 }, () =>
      guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: low, processor: proc }).then((r) => r.body as D)));
    expect(out.filter((d) => d.verdict === 'ALLOW')).toHaveLength(2);
    expect(proc.calls.length, 'only approved payments reach the processor').toBe(2);
    expect(proc.peak, 'the two approved payments executed concurrently').toBe(2);
    expect(store.getMandate(id)!.spent).toBe(80);
    const blocked = out.find((d) => d.verdict === 'BLOCK')!;
    expect(blocked.reasons.find((r) => r.check === 'budget')!.detail).toMatch(/reserved/);
  });

  it('a failed processor call releases the reservation and debits nothing', async () => {
    const { store, guard, issue } = createEnv();
    const { id, token } = issue({ budgetTotal: 50, perTxCap: 40, ...wide });
    const d = (await guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: low, processor: fakeProcessor({ fail: true }) })).body as D;
    expect(d.verdict).toBe('ERROR');
    expect(d.paymentId).toBeNull();
    expect(d.decidedBy!.layer).toBe('processor');
    expect(store.getMandate(id)!.spent).toBe(0);
    expect(guard.reservedTotal(id)).toBe(0);
    const detail = d.reasons.find((r) => r.layer === 'processor')!.detail;
    expect(/abcdefghijklmnop|sk_test_abcdefghijkl/.test(detail), 'credential-shaped text leaked into the ledger').toBe(false);
    const again = (await guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: low, processor: fakeProcessor() })).body as D;
    expect(again.verdict).toBe('ALLOW');                 // the budget is available again
  });

  it('a slow reviewer model does not let a second payment through on stale budget', async () => {
    const { store, guard, issue } = createEnv();
    const { id, token } = issue({ budgetTotal: 60, perTxCap: 40, ...wide });
    const slow = async () => { await sleep(40); return { risk: 'low' as const, reason: '', source: 'stub' }; };
    const out = await Promise.all([1, 2].map(() =>
      guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: slow, processor: fakeProcessor() }).then((r) => r.body as D)));
    expect(out.map((d) => d.verdict).sort()).toEqual(['ALLOW', 'BLOCK']);
    expect(store.getMandate(id)!.spent).toBe(40);
  });

  it('BLOCK and REVIEW release what they reserved', async () => {
    const { guard, issue } = createEnv();
    const { id, token } = issue({ budgetTotal: 60, perTxCap: 40, ...wide });
    await guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: high, processor: fakeProcessor() });
    await guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: med, processor: fakeProcessor() });
    expect(guard.reservedTotal(id)).toBe(0);
    expect(((await guard.guardPayment(token, { ...ok, amount: 40 }, { semantic: low, processor: fakeProcessor() })).body as D).verdict).toBe('ALLOW');
  });

  it('kill switch pulled while a payment is in flight stops it before the processor', async () => {
    const { store, guard, issue } = createEnv();
    const { id, token } = issue({ ...wide });
    const proc = fakeProcessor();
    const slow = async () => { await sleep(40); return { risk: 'low' as const, reason: '', source: 'stub' }; };
    const inFlight = guard.guardPayment(token, ok, { semantic: slow, processor: proc });
    await sleep(10);
    await guard.setFrozen(id, true);
    const d = (await inFlight).body as D;
    expect(d.verdict).toBe('BLOCK');
    expect(proc.calls).toHaveLength(0);
    expect(store.getMandate(id)!.spent).toBe(0);
    expect(guard.reservedTotal(id)).toBe(0);
  });

  it('a demo reset while a payment is at the processor does not crash or lose the record', async () => {
    const { store, guard, issue } = createEnv();
    const { token } = issue({ ...wide });
    const proc = fakeProcessor({ delay: 40 });
    const inFlight = guard.guardPayment(token, ok, { semantic: low, processor: proc });
    await sleep(15);
    store.reset(); guard.resetGuardState();
    const r = await inFlight;
    expect(r.status).toBe(200);
    const body = r.body as D;
    expect(body.verdict).toBe('ERROR');
    expect(body.paymentId).toBe('FAKE-1');
    expect(body.decidedBy!.check).toBe('mandate_missing');
    expect(store.listDecisions(), 'the executed payment is on the ledger').toHaveLength(1);
    expect(guard.auditStatus().ok).toBe(true);
  });
});

describe('store: durability and restart', () => {
  it('mandates, seals, tokens and the ledger survive a restart', async () => {
    const dir = tmp();
    const file = path.join(dir, 'db.json');
    const { store, issue, pay } = createEnv(createMemoryStore({ file }));
    const { id, token } = issue();
    await pay(token, ok);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.decisions).toHaveLength(1);
    expect(fs.existsSync(file + '.tmp'), 'atomic write must not leave a temp file behind').toBe(false);
    expect(onDisk.mandates[id].tokenHash).toHaveLength(64);
    expect(JSON.stringify(onDisk).includes(token), 'the agent token itself must never be persisted').toBe(false);
    // A second store over the same file is what a restarted process sees.
    const reloaded = createMemoryStore({ file });
    expect(reloaded.getMandate(id)!.spent).toBe(40);
    expect(reloaded.decisionsFor(id)).toHaveLength(1);
    expect(reloaded.mandateByTokenHash(onDisk.mandates[id].tokenHash)!.id).toBe(id);
    expect(reloaded.mandateByTokenHash(hashToken(token))!.id).toBe(id);
    expect(sealValid(reloaded.getMandate(id)!)).toBe(true);
    expect(store.health().durable).toBe(true);
  });

  it('replacing a mandate invalidates its old token', () => {
    const { store } = createEnv();
    const a = createMandate({ id: 'same' });
    store.saveMandate(a.mandate);
    const b = createMandate({ id: 'same', budgetTotal: 5 });
    store.saveMandate(b.mandate);
    expect(store.mandateByTokenHash(a.mandate.tokenHash)).toBeNull();
    expect(store.mandateByTokenHash(b.mandate.tokenHash)!.budgetTotal).toBe(5);
  });

  it('a non-durable store pauses payments (503) and review resolution', async () => {
    const base = createMemoryStore();
    const store = { ...base, health: () => ({ ...base.health(), durable: false, lastError: 'disk full' }) };
    const { guard, issue } = createEnv(store);
    const { token } = issue();
    const r = await guard.guardPayment(token, ok, { semantic: low });
    expect(r.status).toBe(503);
    expect(base.listDecisions()).toHaveLength(0);
  });
});

describe('processors', () => {
  it('the mandate picks the rail, the choice is sealed, unknown rails are refused', async () => {
    const { issue, pay } = createEnv();
    expect(() => createMandate({ processor: 'venmo' })).toThrow();
    for (const name of ['paypal', 'stripe']) {
      const { token } = issue({ processor: name });
      const d = await pay(token, ok);
      expect(d.verdict).toBe('ALLOW');
      expect(d.processor).toBe(name);
      expect(d.payment!.processor).toBe(name);
      expect(d.payment!.mode).toBe('simulated');
      expect(d.paymentId).toMatch(new RegExp(`^SIM-${name.toUpperCase()}-`));
    }
    const m = { ...createMandate({ id: 'm', processor: 'paypal' }, now).mandate, processor: 'stripe' };   // rerouted after issue
    expect(sealValid(m)).toBe(false);
  });

  it('same verdicts on every rail (the engine never sees the processor)', async () => {
    const attacks = [
      { ...ok, amount: 5000, recipient: 'wallet_unknown_0xABCD' },
      { ...ok, purpose: 'gift card' },
      { ...ok, amount: -150 },
      ok,
    ];
    const run = async (processor: string) => Promise.all(attacks.map(async (a) => {
      const m = { ...createMandate({ id: 'm', processor }, now).mandate };
      return (await decide(m, a, [], now, none)).verdict;
    }));
    expect(await run('paypal')).toEqual(await run('stripe'));
  });

  it('external rail authorises and debits but never claims verification', async () => {
    const { store, issue, pay } = createEnv();
    const { id, token } = issue({ processor: 'external' });
    const d = await pay(token, ok);
    expect(d.verdict).toBe('ALLOW');
    expect(d.payment!.mode).toBe('external');
    expect(d.payment!.verified).toBe(false);
    expect(d.paymentId).toBe('AUTH-' + d.id);
    expect(store.getMandate(id)!.spent).toBe(40);
    expect((await pay(token, { ...ok, purpose: 'gift card' })).verdict).toBe('BLOCK');
  });

  it('Stripe minor units', () => {
    expect(minorUnits(40.5, 'USD')).toBe(4050);
    expect(minorUnits(0.29, 'USD')).toBe(29);
    expect(minorUnits(500, 'JPY')).toBe(500);
    expect(() => minorUnits(500.5, 'JPY')).toThrow();
  });
});

describe('logging', () => {
  it('purpose text and credential-shaped strings never reach the decision log', async () => {
    const lines: string[] = [];
    const { issue, pay } = createEnv(createMemoryStore(), (l) => lines.push(l));
    const { token } = issue({ ...wide });
    await pay(token, { ...ok, purpose: 'buy a gift card for alice@example.com' });
    await pay(token, { ...ok, purpose: 'weekly groceries for the secret-purpose-text' });
    expect(lines.length).toBe(2);
    const all = lines.join('\n');
    expect(all).not.toMatch(/alice@example\.com|gift card for|secret-purpose-text|sat_/);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
