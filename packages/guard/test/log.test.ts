import { describe, it, expect } from 'vitest';
import { redactText, scrubSecrets, formatDecisionLog } from '../src/index.js';
import type { Decision } from '../src/index.js';

describe('logging', () => {
  it('purpose text and credential-shaped strings never reach the log', () => {
    expect(Object.keys(redactText('buy a gift card for alice@example.com')).sort()).toEqual(['len', 'sha256_8']);
    const s = scrubSecrets('token sat_AbCdEfGhIjKlMnOp, Bearer abc.def.ghijklmn, sk_test_1234567890abcd, sk-ant-api03-zzzzzzzzzz');
    expect(s).not.toMatch(/AbCdEf|abc\.def|1234567890|zzzzzz/);
  });
  it('empty text has no fingerprint', () => {
    expect(redactText('')).toEqual({ len: 0 });
    expect(redactText(null)).toEqual({ len: 0 });
  });
  it('formatDecisionLog is one JSON line carrying a fingerprint of the purpose, never the text', () => {
    const d = {
      seq: 3, id: 'dec_1', kind: 'payment', mandateId: 'm', processor: 'paypal', verdict: 'BLOCK',
      request: { amount: 5, currency: 'USD', recipient: 'merchant sat_AbCdEfGhIjKlMnOp', purpose: 'secret purpose text', idempotencyKey: null },
      decidedBy: { layer: 'intent', check: 'intent' }, reasons: [], riskScore: 0.4, intentSource: 'signature',
      createdAt: '2026-11-12T12:00:00.000Z', payment: null, paymentId: null, resolves: null, effects: [], latencyMs: 4,
      prevHash: '0', hash: '1',
    } as Decision;
    const line = formatDecisionLog(d);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('secret purpose text');
    expect(line).not.toContain('AbCdEfGhIjKlMnOp');
    const j = JSON.parse(line);
    expect(j).toMatchObject({ event: 'decision', verdict: 'BLOCK', layer: 'intent', amount: 5, intent: 'signature' });
    expect(j.purpose.len).toBe('secret purpose text'.length);
    expect(j.purpose.sha256_8).toHaveLength(8);
  });
});
