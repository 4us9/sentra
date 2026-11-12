// Runs the adversarial corpus through the pure decision engine. Invariant 10: nothing in
// the corpus may ever come back ALLOW. See test/corpus/attacks.ts for the contract.
// (The service re-runs the same corpus through its guard chokepoint, where the extra
// "no processor called, budget did not move" assertions live.)
import { describe, it, expect, beforeEach } from 'vitest';
import { configureGuard, resetGuardConfig, createMandate, decide } from '../src/index.js';
import type { SemanticFn } from '../src/index.js';
import { ATTACKS, LEGITIMATE } from './corpus/attacks.js';
import { now } from './helpers.js';

beforeEach(() => {
  resetGuardConfig();
  configureGuard({ secret: () => 'test-secret' });
});

// A reviewer model that has been completely won over by the attacker.
const compromisedModel: SemanticFn = async () => ({ risk: 'low', reason: 'looks fine to me', source: 'llm' });
const noModel: SemanticFn = async () => null;

function freshMandate() {
  return createMandate({ breaker: { blocks: 100000, windowSec: 60 }, velocityLimit: { count: 100000, windowSec: 60 } }, now).mandate;
}

describe('adversarial corpus', () => {
  for (const a of ATTACKS) {
    it(`[${a.tier}] ${a.family}: ${a.name}`, async () => {
      const semantic = a.tier === 'deterministic' ? compromisedModel : noModel;
      const out = await decide(freshMandate(), a.request, [], now, semantic);
      expect(['BLOCK', 'REVIEW'], `expected BLOCK or REVIEW, got ${out.verdict}`).toContain(out.verdict);
      expect(out.verdict).not.toBe('ALLOW');
      expect(out.reasons.some((r) => ['FAIL', 'FLAG', 'high', 'med'].includes(r.result)), 'no reason recorded').toBe(true);
      expect(out.decidedBy, 'no deciding check recorded').not.toBeNull();
    });
  }

  for (const [i, request] of LEGITIMATE.entries()) {
    it(`control: legitimate payment ${i + 1} is still ALLOWED`, async () => {
      const out = await decide(freshMandate(), request, [], now, noModel);
      expect(out.verdict, JSON.stringify(out.reasons.filter((r) => !['pass', 'ok', 'low'].includes(r.result)))).toBe('ALLOW');
    });
  }

  it('corpus is large and covers every family', () => {
    expect(ATTACKS.length, `only ${ATTACKS.length} cases`).toBeGreaterThanOrEqual(80);
    expect(ATTACKS).toHaveLength(93);
    expect(LEGITIMATE).toHaveLength(6);
    for (const f of ['injection', 'cash-out', 'recipient', 'amount', 'currency', 'structure']) {
      expect(ATTACKS.some((a) => a.family === f), `no cases for ${f}`).toBe(true);
    }
  });
});
