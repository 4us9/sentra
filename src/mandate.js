// A mandate is the authority a human delegates to an agent: what it may spend,
// on what, with whom, how fast, until when. Sentra enforces it on every payment.
//
// Two properties make it safe to enforce:
//  - It is SEALED (HMAC over every policy field). If the stored mandate is edited
//    to raise a limit, the seal no longer verifies and every payment is blocked.
//  - The agent gets a bearer token scoped to exactly one mandate. Only the hash is
//    stored. The agent cannot mint a mandate, pick another one, or widen its own.
import crypto from 'crypto';
import { canonical } from './audit.js';
import { secret } from './store.js';
import { isProcessor, defaultProcessorName } from './processors/index.js';

export const DEFAULT_SCOPE = [
  'grocer', 'food', 'produce', 'vegetable', 'fruit', 'meat', 'dairy', 'milk', 'egg',
  'bread', 'bakery', 'pantry', 'snack', 'drink', 'beverage',
];

const SEALED_FIELDS = [
  'id', 'user', 'description', 'scope', 'processor', 'currency', 'budgetTotal', 'perTxCap',
  'allowedRecipients', 'velocityLimit', 'breaker', 'outOfScope', 'expiresAt', 'tokenHash', 'createdAt',
];

export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function sealOf(m) {
  const body = Object.fromEntries(SEALED_FIELDS.map((k) => [k, m[k]]));
  return crypto.createHmac('sha256', secret()).update(canonical(body)).digest('hex');
}

export function sealValid(m) {
  const a = Buffer.from(String(m.seal || ''), 'hex');
  const b = Buffer.from(sealOf(m), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function posNumber(v, fallback, name) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

// Returns { mandate, agentToken }. The token is shown once and never stored.
export function createMandate(partial = {}, now = Date.now()) {
  const agentToken = 'sat_' + crypto.randomBytes(24).toString('base64url');
  const recipients = partial.allowedRecipients ?? ['merchant_freshmart', 'merchant_greengrocer'];
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.some((r) => typeof r !== 'string')) {
    throw new Error('allowedRecipients must be a non-empty list of recipient ids');
  }
  const processor = String(partial.processor || defaultProcessorName()).toLowerCase();
  if (!isProcessor(processor)) throw new Error(`unknown processor "${processor}"`);
  const budgetTotal = posNumber(partial.budgetTotal, 300, 'budgetTotal');
  const perTxCap = posNumber(partial.perTxCap, 75, 'perTxCap');
  const vl = partial.velocityLimit || {};
  const br = partial.breaker || {};
  const mandate = {
    id: partial.id || 'mnd_' + crypto.randomBytes(6).toString('hex'),
    user: String(partial.user || 'demo-user').slice(0, 80),
    description: String(partial.description
      || 'Grocery run. Buy groceries from known merchants only. No transfers, no gift cards.').slice(0, 400),
    scope: Array.isArray(partial.scope) && partial.scope.length ? partial.scope.map(String) : DEFAULT_SCOPE,
    // Which rail executes an ALLOW. Sealed, so an agent cannot reroute its own payments.
    processor,
    currency: String(partial.currency || 'USD').toUpperCase(),
    budgetTotal,
    perTxCap,
    allowedRecipients: recipients,
    velocityLimit: { count: posNumber(vl.count, 6, 'velocityLimit.count'), windowSec: posNumber(vl.windowSec, 60, 'velocityLimit.windowSec') },
    // Circuit breaker: this many BLOCKs inside the window freezes the mandate.
    breaker: { blocks: posNumber(br.blocks, 5, 'breaker.blocks'), windowSec: posNumber(br.windowSec, 120, 'breaker.windowSec') },
    // What to do with an ordinary purchase that is outside the mandate's purpose.
    outOfScope: partial.outOfScope === 'block' ? 'block' : 'review',
    expiresAt: partial.expiresAt ?? new Date(now + 24 * 3600 * 1000).toISOString(),
    tokenHash: hashToken(agentToken),
    createdAt: new Date(now).toISOString(),
    // Mutable runtime state (not sealed):
    spent: 0,
    status: 'active',          // 'active' | 'frozen'
    frozenReason: null,
    breakerResetAt: null,
  };
  if (Number.isNaN(new Date(mandate.expiresAt).getTime())) throw new Error('expiresAt must be a date');
  mandate.seal = sealOf(mandate);
  return { mandate, agentToken };
}

// What the dashboard may see: everything except the credential hash and the seal.
export function publicMandate(m) {
  const { tokenHash: _t, seal: _s, ...rest } = m;
  return { ...rest, sealValid: sealValid(m) };
}
