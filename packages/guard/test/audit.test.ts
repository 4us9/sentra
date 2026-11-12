import { describe, it, expect } from 'vitest';
import { chainEntry, verifyChain, GENESIS, canonical, sha256 } from '../src/index.js';

describe('audit chain', () => {
  it('chain verifies, and any edit to a past entry is detected', () => {
    const a = chainEntry({ id: 'a', verdict: 'ALLOW', amount: 5 }, GENESIS);
    const b = chainEntry({ id: 'b', verdict: 'BLOCK', amount: 5000 }, a.hash);
    expect(verifyChain([a, b]).ok).toBe(true);
    const forged = verifyChain([a, { ...b, verdict: 'ALLOW' }]);
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.brokenAt).toBe(1);
    expect(verifyChain([b]).ok).toBe(false);          // deleting an entry breaks it too
  });
  it('an empty chain is intact at genesis', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0, brokenAt: null, head: GENESIS });
  });
  it('canonical JSON sorts keys at every level and drops undefined', () => {
    expect(canonical({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
    expect(sha256('abc')).toHaveLength(64);
  });
});
