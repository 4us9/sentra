// The demo is part of the product. This runs the exact scenario list the CLI agent
// and the dashboard's Attack Lab use, in order, against the shipped grocery-run
// policy, and fails if any scenario stops giving the verdict it advertises.
// It also proves the "same firewall, any rail" claim: every rail must produce the
// same verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SENTRA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-scn-'));
process.env.SENTRA_SECRET = 'test-secret';
process.env.SENTRA_PROCESSOR_MODE = 'simulate';
process.env.SENTRA_NO_DOTENV = '1';
for (const k of ['ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'STRIPE_SECRET_KEY']) delete process.env[k];

const { SCENARIOS, POISONED_LISTING } = await import('../agent/scenarios.js');
const { createMandate } = await import('../src/mandate.js');
const { loadPolicies, mandateFromPolicy } = await import('../src/policy/config.js');
const store = await import('../src/store.js');
const { guardPayment, setFrozen, auditStatus } = await import('../src/guard.js');

const policy = loadPolicies()['grocery-run'];
const noModel = async () => null;

async function runAll(processor) {
  const { mandate, agentToken } = createMandate({ ...mandateFromPolicy(policy), processor });
  store.saveMandate(mandate);
  const results = {};
  for (const s of SCENARIOS) {
    if (store.getMandate(mandate.id).status === 'frozen') await setFrozen(mandate.id, false);   // the operator step
    const send = (p) => guardPayment(agentToken, p, { semantic: noModel }).then((r) => r.body);
    const out = [];
    if (s.concurrent) out.push(...await Promise.all(s.steps.map(send)));
    else for (const p of s.steps) out.push(await send(p));
    results[s.id] = out;
  }
  return { mandate: store.getMandate(mandate.id), results };
}

store.reset();
const paypal = await runAll('paypal');
const stripe = await runAll('stripe');

for (const s of SCENARIOS) {
  test(`scenario "${s.title}" gives ${s.expect}`, () => {
    const verdicts = paypal.results[s.id].map((d) => d.verdict);
    assert.equal(verdicts.length, s.steps.length);
    if (s.expect === 'MIXED') {
      assert.ok(verdicts.includes('ALLOW'), `expected at least one ALLOW, got ${verdicts}`);
      assert.ok(verdicts.includes('BLOCK'), `expected at least one BLOCK, got ${verdicts}`);
    } else {
      assert.deepEqual([...new Set(verdicts)], [s.expect], `got ${verdicts}`);
    }
    for (const d of paypal.results[s.id]) {
      assert.equal(d.verdict === 'ALLOW', Boolean(d.paymentId), 'only ALLOW may carry a payment id');
    }
  });
}

test('scenarios: each attack is stopped by the layer the demo says it is', () => {
  const by = (id) => paypal.results[id][0].decidedBy;
  assert.deepEqual(by('hijack'), { layer: 'rule', check: 'per_tx_cap' });
  assert.deepEqual(by('giftcard'), { layer: 'intent', check: 'intent' });
  assert.deepEqual(by('offscope'), { layer: 'intent', check: 'intent' });
  assert.deepEqual(by('lookalike'), { layer: 'schema', check: 'recipient_format' });
  assert.deepEqual(by('negative'), { layer: 'schema', check: 'amount_format' });
  // The gift card passes every deterministic check; only intent stops it.
  const giftcard = paypal.results.giftcard[0].reasons;
  assert.ok(giftcard.filter((r) => r.layer !== 'intent').every((r) => ['pass', 'ok'].includes(r.result)));
});

test('scenarios: the hijack payment really is what the poisoned listing asks for', () => {
  const hijack = SCENARIOS.find((s) => s.id === 'hijack').steps[0];
  assert.ok(POISONED_LISTING.includes(String(hijack.amount)));
  assert.ok(POISONED_LISTING.includes(hijack.recipient));
});

test('scenarios: the budget is never exceeded and the breaker ends the run frozen', () => {
  for (const run of [paypal, stripe]) {
    assert.ok(run.mandate.spent <= run.mandate.budgetTotal);
    assert.equal(run.mandate.status, 'frozen');
  }
  assert.equal(auditStatus().ok, true);
});

test('scenarios: same firewall, any rail (identical verdicts on PayPal and Stripe)', () => {
  const shape = (run) => SCENARIOS.map((s) => run.results[s.id].map((d) => `${d.verdict}:${d.decidedBy?.check ?? '-'}`).sort());
  assert.deepEqual(shape(stripe), shape(paypal));
  assert.equal(stripe.mandate.spent, paypal.mandate.spent);
  for (const d of stripe.results.groceries) assert.match(d.paymentId, /^SIM-STRIPE-/);
});
