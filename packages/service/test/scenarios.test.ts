// The demo is part of the product. This runs the exact scenario list the CLI agent
// and the dashboard's Attack Lab use, in order, against the shipped grocery-run
// policy, and fails if any scenario stops giving the verdict it advertises.
// It also proves the "same firewall, any rail" claim: every rail must produce the
// same verdicts.
import { describe, it, expect, beforeAll } from 'vitest';
import { createMandate, mandateFromPolicy, type Decision, type Mandate } from '@sentra/guard';
import { loadPolicies } from '../src/app.js';
import { SCENARIOS, POISONED_LISTING } from '../src/agent/scenarios.js';
import { createEnv, none, POLICY_DIR } from './helpers.js';

type Run = { mandate: Mandate | undefined; results: Record<string, Decision[]> };

const env = createEnv();
const policy = loadPolicies(POLICY_DIR)['grocery-run'];

async function runAll(processor: string): Promise<Run> {
  const { mandate, agentToken } = createMandate({ ...mandateFromPolicy(policy), processor });
  env.store.saveMandate(mandate);
  const results: Record<string, Decision[]> = {};
  for (const s of SCENARIOS) {
    if (env.store.getMandate(mandate.id)!.status === 'frozen') await env.guard.setFrozen(mandate.id, false);   // the operator step
    const send = (p: unknown) => env.guard.guardPayment(agentToken, p, { semantic: none }).then((r) => r.body as Decision);
    const out: Decision[] = [];
    if (s.concurrent) out.push(...await Promise.all(s.steps.map(send)));
    else for (const p of s.steps) out.push(await send(p));
    results[s.id] = out;
  }
  return { mandate: env.store.getMandate(mandate.id), results };
}

let paypal: Run;
let stripe: Run;
beforeAll(async () => {
  paypal = await runAll('paypal');
  stripe = await runAll('stripe');
});

describe('scenarios', () => {
  for (const s of SCENARIOS) {
    it(`scenario "${s.title}" gives ${s.expect}`, () => {
      const verdicts = paypal.results[s.id].map((d) => d.verdict);
      expect(verdicts).toHaveLength(s.steps.length);
      if (s.expect === 'MIXED') {
        expect(verdicts, `expected at least one ALLOW, got ${verdicts}`).toContain('ALLOW');
        expect(verdicts, `expected at least one BLOCK, got ${verdicts}`).toContain('BLOCK');
      } else {
        expect([...new Set(verdicts)], `got ${verdicts}`).toEqual([s.expect]);
      }
      for (const d of paypal.results[s.id]) {
        expect(d.verdict === 'ALLOW', 'only ALLOW may carry a payment id').toBe(Boolean(d.paymentId));
      }
    });
  }

  it('each attack is stopped by the layer the demo says it is', () => {
    const by = (id: string) => paypal.results[id][0].decidedBy;
    expect(by('hijack')).toEqual({ layer: 'rule', check: 'per_tx_cap' });
    expect(by('giftcard')).toEqual({ layer: 'intent', check: 'intent' });
    expect(by('offscope')).toEqual({ layer: 'intent', check: 'intent' });
    expect(by('lookalike')).toEqual({ layer: 'schema', check: 'recipient_format' });
    expect(by('negative')).toEqual({ layer: 'schema', check: 'amount_format' });
    // The gift card passes every deterministic check; only intent stops it.
    const giftcard = paypal.results.giftcard[0].reasons;
    expect(giftcard.filter((r) => r.layer !== 'intent').every((r) => ['pass', 'ok'].includes(r.result))).toBe(true);
  });

  it('the hijack payment really is what the poisoned listing asks for', () => {
    const hijack = SCENARIOS.find((s) => s.id === 'hijack')!.steps[0];
    expect(POISONED_LISTING.includes(String(hijack.amount))).toBe(true);
    expect(POISONED_LISTING.includes(hijack.recipient)).toBe(true);
  });

  it('the budget is never exceeded and the breaker ends the run frozen', () => {
    for (const run of [paypal, stripe]) {
      expect(run.mandate!.spent).toBeLessThanOrEqual(run.mandate!.budgetTotal);
      expect(run.mandate!.status).toBe('frozen');
    }
    expect(env.guard.auditStatus().ok).toBe(true);
  });

  it('same firewall, any rail (identical verdicts on PayPal and Stripe)', () => {
    // verdicts only: which check fires first in a race depends on arrival order
    const shape = (run: Run) => SCENARIOS.map((s) => run.results[s.id].map((d) => d.verdict).sort());
    expect(shape(stripe)).toEqual(shape(paypal));
    expect(stripe.mandate!.spent).toBe(paypal.mandate!.spent);
    for (const d of stripe.results.groceries) expect(d.paymentId).toMatch(/^SIM-STRIPE-/);
  });
});
