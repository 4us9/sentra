// Runs the adversarial corpus through the real guard chokepoint (simulated processor).
// See packages/guard/test/corpus/attacks.ts for the contract: nothing in it may ever
// come back ALLOW, reach a processor, or move the budget.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv, fakeProcessor, type D } from './helpers.js';
import type { SemanticFn } from '@sentra/guard';

// The corpus lives in packages/guard. Loaded by path at runtime (it is the guard
// package's test fixture, not part of this package's compilation unit).
interface Attack { tier: 'deterministic' | 'semantic'; family: string; name: string; request: unknown }
const corpusFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../guard/test/corpus/attacks.ts');
const { ATTACKS, LEGITIMATE } = (await import(/* @vite-ignore */ corpusFile)) as { ATTACKS: Attack[]; LEGITIMATE: unknown[] };

// A reviewer model that has been completely won over by the attacker.
const compromisedModel: SemanticFn = async () => ({ risk: 'low', reason: 'looks fine to me', source: 'llm' });
const noModel: SemanticFn = async () => null;

function freshMandate() {
  const env = createEnv();
  const { id, token } = env.issue({ breaker: { blocks: 100000, windowSec: 60 }, velocityLimit: { count: 100000, windowSec: 60 } });
  return { ...env, id, token };
}

describe('adversarial corpus through the guard chokepoint', () => {
  for (const a of ATTACKS) {
    it(`[${a.tier}] ${a.family}: ${a.name}`, async () => {
      const { id, token, store, guard } = freshMandate();
      const proc = fakeProcessor({ delay: 0 });
      const semantic = a.tier === 'deterministic' ? compromisedModel : noModel;
      const res = await guard.guardPayment(token, a.request, { semantic, processor: proc });
      expect(res.status).toBe(200);
      const d = res.body as D;
      expect(['BLOCK', 'REVIEW'], `expected BLOCK or REVIEW, got ${d.verdict}`).toContain(d.verdict);
      expect(proc.calls, 'a processor was called').toHaveLength(0);
      expect(d.paymentId, 'a payment id was issued').toBeNull();
      expect(d.payment, 'a payment was recorded').toBeNull();
      expect(store.getMandate(id)!.spent, 'budget moved').toBe(0);
      expect(guard.reservedTotal(id), 'a reservation leaked').toBe(0);
      expect(d.reasons.some((r) => ['FAIL', 'FLAG', 'high', 'med'].includes(r.result)), 'no reason recorded').toBe(true);
      expect(guard.auditStatus().ok).toBe(true);
    });
  }

  for (const [i, request] of LEGITIMATE.entries()) {
    it(`control: legitimate payment ${i + 1} is still ALLOWED`, async () => {
      const { token, guard } = freshMandate();
      const d = (await guard.guardPayment(token, request, { semantic: noModel })).body as D;
      expect(d.verdict, JSON.stringify(d.reasons.filter((r) => !['pass', 'ok', 'low'].includes(r.result)))).toBe('ALLOW');
    });
  }

  it('the corpus is large and covers every family', () => {
    expect(ATTACKS.length, `only ${ATTACKS.length} cases`).toBeGreaterThanOrEqual(80);
    for (const f of ['injection', 'cash-out', 'recipient', 'amount', 'currency', 'structure']) {
      expect(ATTACKS.some((a) => a.family === f), `no cases for ${f}`).toBe(true);
    }
  });
});
