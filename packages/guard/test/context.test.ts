import { describe, it, expect, beforeEach } from 'vitest';
import { configureGuard, resetGuardConfig, createMandate, sealValid } from '../src/index.js';

beforeEach(() => resetGuardConfig());

describe('configureGuard', () => {
  it('has no secret by default: sealing throws instead of using a guessed key', () => {
    expect(() => createMandate({})).toThrow('Sentra guard: no secret configured');
  });
  it('the secret is read at call time', () => {
    let key = 'a';
    configureGuard({ secret: () => key });
    const { mandate } = createMandate({});
    expect(sealValid(mandate)).toBe(true);
    key = 'b';
    expect(sealValid(mandate)).toBe(false);
  });
  it('resetGuardConfig restores defaults', () => {
    configureGuard({ secret: () => 's', processors: ['acme'], defaultProcessor: 'acme' });
    resetGuardConfig();
    configureGuard({ secret: () => 's' });
    expect(createMandate({}).mandate.processor).toBe('paypal');
    expect(() => createMandate({ processor: 'acme' })).toThrow();
  });
});
