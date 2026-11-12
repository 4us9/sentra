import { describe, it, expect } from 'vitest';
import { csvCell, toCsv, queryLedger, computeMetrics, toPrometheus, chainEntry, verifyChain, GENESIS } from '../src/index.js';
import type { Decision, PendingDecision } from '../src/index.js';

function entry(over: Partial<PendingDecision> & { id: string }, i: number): PendingDecision {
  return {
    kind: 'payment', mandateId: 'm1', processor: 'paypal',
    request: { amount: 40, currency: 'USD', recipient: 'merchant_freshmart', purpose: 'weekly groceries' },
    verdict: 'ALLOW', reasons: [], riskScore: 0, intentSource: 'fallback', decidedBy: null,
    createdAt: new Date(Date.UTC(2026, 10, 12, 12, 0, i)).toISOString(),
    payment: null, paymentId: null, resolves: null, effects: [], latencyMs: 10 + i,
    ...over,
  };
}

function build(items: Array<Partial<PendingDecision> & { id: string }>): Decision[] {
  let prev = GENESIS;
  return items.map((it, i) => {
    const c = chainEntry({ ...entry(it, i), seq: i }, prev);
    prev = c.hash;
    return c as unknown as Decision;
  });
}

const ledger = build([
  { id: 'd0', paymentId: 'SIM-PAYPAL-1', payment: { processor: 'paypal', id: 'SIM-PAYPAL-1', status: 'OK', mode: 'simulated', verified: true } },
  { id: 'd1', verdict: 'BLOCK', processor: 'stripe', request: { amount: 5000, currency: 'USD', recipient: 'wallet_x', purpose: '=HYPERLINK("http://evil.example","click")' },
    decidedBy: { layer: 'rule', check: 'per_tx_cap' },
    reasons: [{ layer: 'rule', check: 'per_tx_cap', result: 'FAIL', detail: 'amount 5000 vs cap 75' }] },
  { id: 'd2', verdict: 'BLOCK', decidedBy: { layer: 'intent', check: 'intent' }, request: { amount: 20, currency: 'USD', recipient: 'merchant_freshmart', purpose: 'gift card' } },
  { id: 'd3', verdict: 'REVIEW', decidedBy: { layer: 'intent', check: 'intent' }, request: { amount: 10, currency: 'USD', recipient: 'merchant_greengrocer', purpose: 'headphones' } },
  { id: 'd4', verdict: 'ALLOW', processor: 'stripe', mandateId: 'm2' },
  { id: 'd5', kind: 'review_resolution', verdict: 'BLOCK', resolves: 'd3', decidedBy: { layer: 'human', check: 'human_review' } },
  { id: 'd6', kind: 'event', verdict: 'INFO', request: { amount: 0, currency: 'USD', recipient: '', purpose: '' } },
]);

describe('ledger', () => {
  it('the built ledger is a valid chain', () => {
    expect(verifyChain(ledger).ok).toBe(true);
  });

  it('csv cells are escaped and formula-safe', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-150')).toBe("'-150");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell(-150)).toBe('-150');          // real numbers stay numbers
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('toCsv has a header, one row per entry, and neutralises formulas', () => {
    const csv = toCsv(ledger);
    const lines = csv.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(ledger.length + 1);
    expect(lines[0]).toMatch(/^seq,time,decision_id,.*decided_by_layer,decided_by_check,.*prev_hash,hash$/);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(csv).toContain('amount 5000 vs cap 75');   // the "why" column
  });

  it('queryLedger filters by verdict, kind, mandate, layer, check, processor, time and text', () => {
    expect(queryLedger(ledger).total).toBe(7);
    expect(queryLedger(ledger, { verdict: 'block' }).entries.map((d) => d.id)).toEqual(['d1', 'd2', 'd5']);
    expect(queryLedger(ledger, { verdict: 'ALLOW,REVIEW' }).total).toBe(3);
    expect(queryLedger(ledger, { kind: 'event' }).entries.map((d) => d.id)).toEqual(['d6']);
    expect(queryLedger(ledger, { mandate: 'm2' }).entries.map((d) => d.id)).toEqual(['d4']);
    expect(queryLedger(ledger, { layer: 'intent' }).total).toBe(2);
    expect(queryLedger(ledger, { check: 'per_tx_cap' }).entries.map((d) => d.id)).toEqual(['d1']);
    expect(queryLedger(ledger, { processor: 'stripe' }).total).toBe(2);
    expect(queryLedger(ledger, { since: '2026-11-12T12:00:03.000Z' }).total).toBe(4);
    expect(queryLedger(ledger, { until: '2026-11-12T12:00:03.000Z' }).total).toBe(3);
    expect(queryLedger(ledger, { q: 'GIFT' }).entries.map((d) => d.id)).toEqual(['d2']);
    expect(queryLedger(ledger, { q: 'sim-paypal-1' }).entries.map((d) => d.id)).toEqual(['d0']);
  });

  it('queryLedger paginates and clamps limit and offset', () => {
    const page = queryLedger(ledger, { limit: 2, offset: 2 });
    expect(page).toMatchObject({ total: 7, offset: 2, limit: 2 });
    expect(page.entries.map((d) => d.id)).toEqual(['d2', 'd3']);
    expect(queryLedger(ledger, { limit: 999999 }).limit).toBe(5000);
    expect(queryLedger(ledger, { limit: -5, offset: -5 })).toMatchObject({ limit: 1, offset: 0 });
    expect(queryLedger(ledger, { limit: 0 }).limit).toBe(500);
    expect(queryLedger([], {}).total).toBe(0);
  });

  it('metrics agree with the ledger; empty ledger does not divide by zero', () => {
    const m = computeMetrics(ledger, [{ status: 'active' }, { status: 'frozen' }], { reserved: 12 });
    expect(m.decisions).toBe(6);                 // events are not counted
    expect(m.byVerdict).toEqual({ ALLOW: 2, BLOCK: 3, REVIEW: 1, ERROR: 0 });
    expect(m.blockRate).toBe(0.5);
    expect(m.spendByProcessor).toEqual({ paypal: 40, stripe: 40 });
    expect(m.spendTotal).toBe(80);
    expect(m.stoppedByLayer).toEqual({ rule: 1, intent: 2, human: 1 });
    expect(m.stoppedByCheck).toMatchObject({ per_tx_cap: 1, intent: 2 });
    expect(m.blockedValue).toBe(5020);           // only kind=payment BLOCKs
    expect(m.reservedInFlight).toBe(12);
    expect(m.reviewsPending).toBe(0);            // d3 was resolved by d5
    expect(m.latencyMs.samples).toBe(5);
    expect(m.latencyMs.p95).toBeGreaterThanOrEqual(m.latencyMs.p50);
    expect(m.mandates).toEqual({ total: 2, frozen: 1 });

    const empty = computeMetrics([], []);
    expect(empty.blockRate).toBe(0);
    expect(empty.latencyMs.p95).toBe(0);
  });

  it('a held REVIEW with no resolution counts as pending', () => {
    expect(computeMetrics(ledger.slice(0, 4), []).reviewsPending).toBe(1);
  });

  it('prometheus exposition carries the key series', () => {
    const m = computeMetrics(ledger, []);
    const prom = toPrometheus(m, { length: ledger.length, ok: true });
    expect(prom).toMatch(/sentra_decisions_total\{verdict="BLOCK"\} 3/);
    expect(prom).toMatch(/sentra_spend_total\{processor="stripe"\} 40/);
    expect(prom).toMatch(/sentra_ledger_intact 1/);
    expect(prom).toMatch(/sentra_decision_latency_ms\{quantile="0\.95"\}/);
    expect(prom).toMatch(/^# HELP sentra_block_rate /m);
    expect(prom.endsWith('\n')).toBe(true);
    expect(toPrometheus(m, { length: 1, ok: false })).toMatch(/sentra_ledger_intact 0/);
  });
});
