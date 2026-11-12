import { describe, it, expect, beforeEach } from 'vitest';
import {
  configureGuard, resetGuardConfig, createMandate, sealOf, sealValid, publicMandate, hashToken, DEFAULT_SCOPE, SEALED_FIELDS,
} from '../src/index.js';
import { now, mandate } from './helpers.js';

beforeEach(() => {
  resetGuardConfig();
  configureGuard({ secret: () => 'test-secret' });
});

describe('mandate', () => {
  it('createMandate returns a sealed mandate and a one-time token whose hash is stored', () => {
    const { mandate: m, agentToken } = createMandate({}, now);
    expect(agentToken).toMatch(/^sat_/);
    expect(m.tokenHash).toBe(hashToken(agentToken));
    expect(m.tokenHash).toHaveLength(64);
    expect(JSON.stringify(m)).not.toContain(agentToken);
    expect(sealValid(m)).toBe(true);
    expect(m.scope).toEqual(DEFAULT_SCOPE);
    expect(m.processor).toBe('paypal');
    expect(m.createdAt).toBe(new Date(now).toISOString());
    expect(m.expiresAt).toBe(new Date(now + 24 * 3600 * 1000).toISOString());
    expect(m.status).toBe('active');
  });
  it('every sealed field is covered: editing any of them breaks the seal', () => {
    const base = mandate();
    const edits: Record<string, unknown> = {
      id: 'x', user: 'x', policy: 'x', description: 'x', scope: ['x'], processor: 'stripe', currency: 'EUR', budgetTotal: 1,
      perTxCap: 1, allowedRecipients: ['x'], velocityLimit: { count: 99, windowSec: 1 }, breaker: { blocks: 99, windowSec: 1 },
      outOfScope: 'block', expiresAt: '2099-01-01T00:00:00.000Z', tokenHash: 'x', createdAt: '2000-01-01T00:00:00.000Z',
    };
    for (const k of SEALED_FIELDS) {
      expect(sealValid({ ...base, [k]: edits[k] })).toBe(false);
    }
    // runtime state is not sealed
    expect(sealValid({ ...base, spent: 50, status: 'frozen' } as typeof base)).toBe(true);
  });
  it('the processor is sealed: rerouting after issue fails the seal', () => {
    const m = mandate({ processor: 'paypal' }, { processor: 'stripe' });
    expect(sealValid(m)).toBe(false);
  });
  it('unknown processors are refused; configured list and default are honoured', () => {
    expect(() => createMandate({ processor: 'venmo' })).toThrow(/unknown processor "venmo"/);
    expect(createMandate({ processor: 'STRIPE' }).mandate.processor).toBe('stripe');
    expect(createMandate({ processor: 'external' }).mandate.processor).toBe('external');
    configureGuard({ processors: ['acme'], defaultProcessor: 'acme' });
    expect(createMandate({}).mandate.processor).toBe('acme');
    expect(() => createMandate({ processor: 'paypal' })).toThrow();
  });
  it('rejects bad input', () => {
    expect(() => createMandate({ budgetTotal: -1 })).toThrow(/budgetTotal/);
    expect(() => createMandate({ perTxCap: 'abc' })).toThrow(/perTxCap/);
    expect(() => createMandate({ allowedRecipients: [] })).toThrow(/allowedRecipients/);
    expect(() => createMandate({ allowedRecipients: [5] })).toThrow(/allowedRecipients/);
    expect(() => createMandate({ expiresAt: 'not a date' })).toThrow(/expiresAt/);
    expect(() => createMandate({ velocityLimit: { count: 0 } })).toThrow(/velocityLimit.count/);
  });
  it('sealOf needs a configured secret: default throws, never a guessed key', () => {
    resetGuardConfig();
    expect(() => sealOf(mandateForSeal())).toThrow('Sentra guard: no secret configured');
  });
  it('a different secret produces a different seal', () => {
    const m = mandate();
    configureGuard({ secret: () => 'other' });
    expect(sealValid(m)).toBe(false);
  });
  it('publicMandate hides the token hash and seal but reports seal validity', () => {
    const m = mandate();
    const p = publicMandate(m);
    expect('tokenHash' in p).toBe(false);
    expect('seal' in p).toBe(false);
    expect(p.sealValid).toBe(true);
    expect(publicMandate({ ...m, budgetTotal: 9 }).sealValid).toBe(false);
  });
});

function mandateForSeal() {
  configureGuard({ secret: () => 'tmp' });
  const m = createMandate({}, now).mandate;
  resetGuardConfig();
  return m;
}
