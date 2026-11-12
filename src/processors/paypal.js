// PayPal processor: OAuth client-credentials + Orders API v2. SANDBOX ONLY: any other
// API base is refused when this module loads.
import '../env.js';
import { toCents } from '../policy/validate.js';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const BASE = (process.env.PAYPAL_BASE || SANDBOX).replace(/\/+$/, '');
if (BASE !== SANDBOX) {
  throw new Error(`Refusing to start: PAYPAL_BASE must be ${SANDBOX} (sandbox only), got ${BASE}`);
}

const configured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

/** @type {{ tok: string, exp: number } | null} */
let cached = null;
async function getToken() {
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

/**
 * The body is whatever PayPal answered, parsed. It is not trusted: createPayment
 * re-checks the amount and currency before reporting success.
 * @param {string} pathname
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
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

/**
 * @param {string} id
 * @returns {Promise<any>} the order as PayPal returned it
 */
export async function getOrder(id) {
  const res = await api(`/v2/checkout/orders/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getOrder ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

/** @type {import('./index.js').PaymentProcessor} */
export const paypal = {
  name: 'paypal',
  label: 'PayPal',
  mode: () => (configured() ? 'sandbox' : 'simulated'),

  async createPayment({ amount, currency, recipient, purpose, idempotencyKey }) {
    const value = (toCents(amount) / 100).toFixed(2);
    const res = await api('/v2/checkout/orders', {
      method: 'POST',
      // PayPal-Request-Id makes the create idempotent on PayPal's side.
      headers: { 'PayPal-Request-Id': idempotencyKey, Prefer: 'return=representation' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: idempotencyKey,
          custom_id: String(recipient).slice(0, 127),
          description: (String(purpose || 'agent payment').replace(/[^\x20-\x7E]/g, ' ').slice(0, 120)) || 'agent payment',
          amount: { currency_code: currency, value },
        }],
      }),
    });
    if (!res.ok) throw new Error(`PayPal createOrder ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
    // Read the order back if the create response did not include it in full, then
    // check PayPal recorded exactly what Sentra approved.
    const order = res.body.purchase_units?.[0]?.amount ? res.body : await getOrder(res.body.id);
    const got = order.purchase_units?.[0]?.amount;
    if (!got || got.currency_code !== currency || toCents(got.value) !== toCents(value)) {
      throw new Error(`PayPal order ${res.body.id} mismatch: approved ${value} ${currency}, PayPal has ${got?.value} ${got?.currency_code}`);
    }
    return { processor: 'paypal', id: res.body.id, status: res.body.status, mode: 'sandbox', verified: true };
  },
};
