import { describe, it, expect, beforeEach } from 'vitest';
import { configureGuard, resetGuardConfig, validatePolicy, mandateFromPolicy, createMandate, POLICY_VERSION } from '../src/index.js';
import type { Policy } from '../src/index.js';

// Mirrors policies/grocery-run.json (the service loads the real files).
const good: Policy = {
  version: 1,
  name: 'grocery-run',
  description: 'Grocery run. Buy groceries from known merchants only. No transfers, no gift cards.',
  currency: 'USD',
  budgetTotal: 300,
  perTxCap: 75,
  allowedRecipients: ['merchant_freshmart', 'merchant_greengrocer'],
  scope: ['grocer', 'food', 'produce', 'vegetable', 'fruit', 'meat', 'dairy', 'milk', 'egg', 'bread', 'bakery', 'pantry', 'snack', 'drink', 'beverage'],
  outOfScope: 'review',
  velocityLimit: { count: 6, windowSec: 60 },
  breaker: { blocks: 5, windowSec: 120 },
  ttlHours: 24,
};
const bad = (over: Record<string, unknown>) => validatePolicy({ ...good, ...over }).join();

beforeEach(() => {
  resetGuardConfig();
  configureGuard({ secret: () => 'test-secret' });
});

describe('policy', () => {
  it('a good policy is valid', () => {
    expect(POLICY_VERSION).toBe(1);
    expect(validatePolicy(good)).toEqual([]);
    expect(validatePolicy({ ...good, processor: 'stripe', $schema: './policy.schema.json' })).toEqual([]);
  });
  it('validator is strict (typos, bad limits, missing allowlist)', () => {
    expect(bad({ perTxcap: 10 })).toMatch(/unknown field "perTxcap"/);
    expect(bad({ version: 2 })).toMatch(/version/);
    expect(bad({ perTxCap: 9999 })).toMatch(/cannot exceed/);
    expect(bad({ allowedRecipients: [] })).toMatch(/non-empty/);
    expect(bad({ allowedRecipients: ['ok', 'bаd'] })).toMatch(/invalid id/);
    expect(bad({ allowedRecipients: ['a', 'a'] })).toMatch(/duplicates/);
    expect(bad({ budgetTotal: '300' })).toMatch(/budgetTotal/);
    expect(bad({ processor: 'venmo' })).toMatch(/processor/);
    expect(bad({ outOfScope: 'allow' })).toMatch(/outOfScope/);
    expect(bad({ name: 'Bad Name' })).toMatch(/name/);
    expect(bad({ currency: 'usd' })).toMatch(/currency/);
    expect(bad({ scope: ['x'] })).toMatch(/scope/);
    expect(bad({ velocityLimit: { count: 1 } })).toMatch(/velocityLimit/);
    expect(bad({ breaker: { blocks: 1.5, windowSec: 1 } })).toMatch(/breaker/);
    expect(bad({ ttlHours: 9000 })).toMatch(/ttlHours/);
    expect(validatePolicy(null).join()).toMatch(/object/);
    expect(validatePolicy([]).join()).toMatch(/object/);
  });
  it('the processor check uses the configured list', () => {
    configureGuard({ processors: ['acme'] });
    expect(bad({ processor: 'paypal' })).toMatch(/unknown processor "paypal"/);
    expect(bad({ processor: 'acme' })).toBe('');
  });
  it('mandateFromPolicy carries limits, policy name and expiry; ttl defaults to 24h', () => {
    const f = mandateFromPolicy(good, 0);
    expect(f.expiresAt).toBe(new Date(24 * 3600e3).toISOString());
    expect(f.policy).toBe('grocery-run');
    expect(f).not.toHaveProperty('ttlHours');
    expect(f).not.toHaveProperty('version');
    const { ttlHours: _t, ...noTtl } = good;
    expect(mandateFromPolicy(noTtl, 0).expiresAt).toBe(new Date(24 * 3600e3).toISOString());
    expect(mandateFromPolicy({ ...good, ttlHours: 72 }, 0).expiresAt).toBe(new Date(72 * 3600e3).toISOString());
    const { mandate } = createMandate(f, 0);
    expect(mandate.policy).toBe('grocery-run');
    expect(mandate.budgetTotal).toBe(300);
    expect(mandate.perTxCap).toBe(75);
  });
});
