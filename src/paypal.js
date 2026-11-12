// The only code in the system that holds PayPal credentials. The agent never sees
// them: it can ask Sentra to pay, and that is all it can do.
//
// SANDBOX ONLY. Any other API base is refused at load time.
// With no credentials, Sentra runs in clearly-labelled SIMULATED mode (order ids
// start with SIM-) so the firewall can be exercised offline and in tests.
import './env.js';
import crypto from 'crypto';
import { toCents } from './policy/validate.js';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const BASE = (process.env.PAYPAL_BASE || SANDBOX).replace(/\/+$/, '');
if (BASE !== SANDBOX) {
  throw new Error(`Refusing to start: PAYPAL_BASE must be ${SANDBOX} (sandbox only), got ${BASE}`);
}

export function mode() {
  if (process.env.PAYPAL_MODE === 'simulate') return 'simulated';
  return process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? 'sandbox' : 'simulated';
}

let cached = null;
export async function getToken() {
  if (cached && cached.exp > Date.now()) return cached.tok;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`PayPal token failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  cached = { tok: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.tok;
}

async function api(pathname, opts = {}) {
  const tok = await getToken();
  const r = await fetch(`${BASE}${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, body };
}

// Execute an approved payment as a PayPal order, then verify PayPal recorded exactly
// what Sentra approved. requestId makes the call idempotent on PayPal's side, so a
// retry can never create a second order for one decision.
export async function executePayment({ decisionId, amount, currency, recipient, purpose }) {
  const value = (toCents(amount) / 100).toFixed(2);
  if (mode() === 'simulated') {
    return { orderId: 'SIM-' + crypto.randomBytes(6).toString('hex').toUpperCase(), status: 'SIMULATED', mode: 'simulated', verified: true };
  }
  const res = await api('/v2/checkout/orders', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': decisionId, Prefer: 'return=representation' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: decisionId,
        custom_id: String(recipient).slice(0, 127),
        description: (String(purpose || 'agent payment').replace(/[^\x20-\x7E]/g, ' ').slice(0, 120)) || 'agent payment',
        amount: { currency_code: currency, value },
      }],
    }),
  });
  if (!res.ok) throw new Error(`createOrder ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  // Read the order back if the create response did not include it in full.
  const order = res.body.purchase_units?.[0]?.amount ? res.body : await getOrder(res.body.id);
  const got = order.purchase_units?.[0]?.amount;
  // Post-execution verification: never trust that what was created is what was approved.
  if (!got || got.currency_code !== currency || toCents(got.value) !== toCents(value)) {
    throw new Error(`order ${res.body.id} amount mismatch: approved ${value} ${currency}, PayPal has ${got?.value} ${got?.currency_code}`);
  }
  return { orderId: res.body.id, status: res.body.status, mode: 'sandbox', verified: true };
}

export async function getOrder(id) {
  const res = await api(`/v2/checkout/orders/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getOrder ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}
