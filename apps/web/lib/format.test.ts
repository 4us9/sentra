import { describe, expect, it } from 'vitest';
import { decidingText, money, nonAscii, pendingReviews, splitSource, str } from './format';
import type { Decision } from './types';

const base = { kind: 'payment', verdict: 'BLOCK', reasons: [], decidedBy: null, resolves: null } as unknown as Decision;

describe('format', () => {
  it('bounds and stringifies untrusted values', () => {
    expect(str('x'.repeat(1000), 10)).toBe('xxxxxxxxxx...');
    expect(str({ a: 1 })).toBe('{"a":1}');
    expect(str(null)).toBe('');
  });
  it('formats money and tolerates garbage', () => {
    expect(money(5000, 'USD')).toBe('$5,000.00');
    expect(money('1e3')).toBe('1e3');
    expect(money(40, '<script>')).toBe('$40.00');
  });
  it('finds non-ascii look-alikes', () => {
    expect(nonAscii('merchant_freshmаrt')[0]).toContain('U+0430');
    expect(nonAscii('plain')).toEqual([]);
  });
  it('splits the intent source suffix', () => {
    expect(splitSource('cash-out language [signature]')).toEqual({ text: 'cash-out language', source: 'signature' });
  });
  it('explains the deciding reason', () => {
    const d = { ...base, reasons: [{ layer: 'rule', check: 'per_tx_cap', result: 'FAIL', detail: 'over cap' }], decidedBy: { layer: 'rule', check: 'per_tx_cap' } } as Decision;
    expect(decidingText(d)).toBe('per_tx_cap: over cap');
  });
  it('finds unresolved reviews', () => {
    const held = { ...base, id: 'a', verdict: 'REVIEW' } as Decision;
    const done = { ...base, id: 'b', verdict: 'INFO', resolves: 'a' } as Decision;
    expect(pendingReviews([held])).toHaveLength(1);
    expect(pendingReviews([held, done])).toHaveLength(0);
  });
});
