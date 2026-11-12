// Stripe processor: PaymentIntents. TEST MODE ONLY: the key must be a test key
// (sk_test_ / rk_test_); a live key is refused and never sent anywhere.
//
// The intent is created and confirmed in one call against Stripe's built-in test
// payment method, so an ALLOW ends as a succeeded test charge. No Stripe SDK: one
// form-encoded POST keeps the dependency surface small.
import '../env.js';
import { toCents } from '@sentra/guard';
import type { PaymentProcessor } from './types.js';

const API = 'https://api.stripe.com/v1';
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

const key = () => process.env.STRIPE_SECRET_KEY || '';
const isTestKey = (k: string): boolean => /^(sk|rk)_test_/.test(k);

if (key() && !isTestKey(key())) {
  throw new Error('Refusing to start: STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)');
}

/** Amount in Stripe's smallest unit for the currency. */
export function minorUnits(amount: number | string, currency: string): number {
  if (ZERO_DECIMAL.has(currency)) {
    if (!Number.isInteger(Number(amount))) throw new Error(`${currency} has no minor unit; amount must be whole`);
    return Number(amount);
  }
  return toCents(amount);
}

export const stripe: PaymentProcessor = {
  name: 'stripe',
  label: 'Stripe',
  mode: () => (isTestKey(key()) ? 'test' : 'simulated'),

  async createPayment({ amount, currency, recipient, purpose, idempotencyKey }) {
    const k = key();
    if (!isTestKey(k)) throw new Error('Stripe is not configured with a test-mode key');
    const minor = minorUnits(amount, currency);
    const body = new URLSearchParams({
      amount: String(minor),
      currency: currency.toLowerCase(),
      payment_method: 'pm_card_visa',                       // Stripe's test payment method
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      description: (String(purpose || 'agent payment').replace(/[^\x20-\x7E]/g, ' ').slice(0, 200)) || 'agent payment',
      'metadata[sentra_decision]': idempotencyKey,
      'metadata[recipient]': String(recipient).slice(0, 127),
    });
    const r = await fetch(`${API}/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${k}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,                  // idempotent on Stripe's side
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe payment_intents ${r.status}: ${String(j.error?.message || '').slice(0, 300)}`);
    if (j.livemode !== false) throw new Error(`Stripe intent ${j.id} is not a test-mode object`);
    if (j.amount !== minor || String(j.currency).toUpperCase() !== currency) {
      throw new Error(`Stripe intent ${j.id} mismatch: approved ${minor} ${currency}, Stripe has ${j.amount} ${j.currency}`);
    }
    return { processor: 'stripe', id: j.id, status: j.status, mode: 'test', verified: true };
  },
};
