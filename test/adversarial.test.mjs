// Runs the adversarial corpus through the real guard chokepoint (simulated processor).
// See test/corpus/attacks.mjs for the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SENTRA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-adv-'));
process.env.SENTRA_SECRET = 'test-secret';
process.env.PAYPAL_MODE = 'simulate';
process.env.SENTRA_PROCESSOR_MODE = 'simulate';
process.env.SENTRA_NO_DOTENV = '1';        // never read the developer's .env
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { ATTACKS, LEGITIMATE } = await import('./corpus/attacks.mjs');
const { createMandate } = await import('../src/mandate.js');
const store = await import('../src/store.js');
const { guardPayment } = await import('../src/guard.js');

// A reviewer model that has been completely won over by the attacker.
const compromisedModel = async () => ({ risk: 'low', reason: 'looks fine to me', source: 'llm' });
const noModel = async () => null;

function freshMandate() {
  const { mandate, agentToken } = createMandate({ breaker: { blocks: 100000, windowSec: 60 }, velocityLimit: { count: 100000, windowSec: 60 } });
  store.saveMandate(mandate);
  return { id: mandate.id, token: agentToken };
}

store.reset();

for (const a of ATTACKS) {
  test(`adversarial [${a.tier}] ${a.family}: ${a.name}`, async () => {
    const { id, token } = freshMandate();
    const semantic = a.tier === 'deterministic' ? compromisedModel : noModel;
    const res = await guardPayment(token, a.request, { semantic });
    assert.equal(res.status, 200);
    const d = res.body;
    assert.ok(['BLOCK', 'REVIEW'].includes(d.verdict), `expected BLOCK or REVIEW, got ${d.verdict}`);
    assert.equal(d.paypalOrderId, null, 'a processor was called');
    assert.equal(d.payment ?? d.paypal ?? null, null, 'a processor was called');
    assert.equal(store.getMandate(id).spent, 0, 'budget moved');
    assert.ok(d.reasons.some((r) => ['FAIL', 'FLAG', 'high', 'med'].includes(r.result)), 'no reason recorded');
  });
}

for (const [i, request] of LEGITIMATE.entries()) {
  test(`adversarial control: legitimate payment ${i + 1} is still ALLOWED`, async () => {
    const { token } = freshMandate();
    const d = (await guardPayment(token, request, { semantic: noModel })).body;
    assert.equal(d.verdict, 'ALLOW', JSON.stringify(d.reasons.filter((r) => !['pass', 'ok', 'low'].includes(r.result))));
  });
}

test('adversarial: corpus is large and covers every family', () => {
  assert.ok(ATTACKS.length >= 80, `only ${ATTACKS.length} cases`);
  for (const f of ['injection', 'cash-out', 'recipient', 'amount', 'currency', 'structure']) {
    assert.ok(ATTACKS.some((a) => a.family === f), `no cases for ${f}`);
  }
});
