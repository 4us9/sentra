// Layer 1: deterministic hard rules. Each returns { name, pass, detail }.
// Exact, fast, no AI. Money is compared in integer cents so floating point can
// never round a payment under a limit.
import { toCents } from './validate.js';
import { sealValid } from '../mandate.js';

/**
 * @typedef {import('../types.js').Mandate} Mandate
 * @typedef {import('../types.js').NormalizedRequest} NormalizedRequest
 * @typedef {import('../types.js').HistoryEntry} HistoryEntry
 * @typedef {import('../types.js').RuleResult} RuleResult
 */

/** @param {Mandate} mandate @returns {RuleResult} */
export function mandateIntegrity(mandate) {
  const pass = sealValid(mandate);
  return { name: 'mandate_integrity', pass, detail: pass ? 'seal verified' : 'mandate seal does NOT verify: policy was modified after issue' };
}

/** @param {Mandate} mandate @returns {RuleResult} */
export function mandateActive(mandate) {
  const pass = mandate.status !== 'frozen';
  return { name: 'mandate_active', pass, detail: pass ? 'active' : `frozen: ${mandate.frozenReason || 'by operator'}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @param {number} [now] @returns {RuleResult} */
export function expiry(mandate, req, now = Date.now()) {
  const pass = now < new Date(mandate.expiresAt).getTime();
  return { name: 'expiry', pass, detail: `mandate expires ${mandate.expiresAt}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @returns {RuleResult} */
export function currency(mandate, req) {
  const pass = req.currency === mandate.currency;
  return { name: 'currency', pass, detail: `${req.currency} vs mandate ${mandate.currency}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @returns {RuleResult} */
export function perTxCap(mandate, req) {
  const pass = toCents(req.amount) <= toCents(mandate.perTxCap);
  return { name: 'per_tx_cap', pass, detail: `amount ${req.amount} vs cap ${mandate.perTxCap}` };
}

// `reserved` is money already promised to payments that are in flight (approved, not
// yet settled). Counting it here is what closes the double-spend race.
/** @param {Mandate} mandate @param {NormalizedRequest} req @returns {RuleResult} */
export function budget(mandate, req) {
  const reserved = mandate.reserved || 0;
  const pass = toCents(mandate.spent) + toCents(reserved) + toCents(req.amount) <= toCents(mandate.budgetTotal);
  const held = reserved ? ` + ${reserved} reserved` : '';
  return { name: 'budget', pass, detail: `spent ${mandate.spent}${held} + ${req.amount} vs total ${mandate.budgetTotal}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @returns {RuleResult} */
export function recipientAllowlist(mandate, req) {
  const pass = mandate.allowedRecipients.includes(req.recipient);
  return { name: 'recipient_allowlist', pass, detail: `recipient ${req.recipient} ${pass ? 'in' : 'NOT in'} allowlist` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @param {HistoryEntry[]} history @param {number} [now] @returns {RuleResult} */
export function velocity(mandate, req, history, now = Date.now()) {
  const { count, windowSec } = mandate.velocityLimit;
  const recent = history.filter(
    (d) => d.verdict === 'ALLOW' && (now - new Date(d.createdAt).getTime()) <= windowSec * 1000
  );
  const pass = recent.length < count;
  return { name: 'velocity', pass, detail: `${recent.length} allowed in last ${windowSec}s vs limit ${count}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @param {HistoryEntry[]} history @param {number} [now] @returns {RuleResult[]} */
export function runHardRules(mandate, req, history, now = Date.now()) {
  return [
    mandateIntegrity(mandate),
    mandateActive(mandate),
    expiry(mandate, req, now),
    currency(mandate, req),
    perTxCap(mandate, req),
    budget(mandate, req),
    recipientAllowlist(mandate, req),
    velocity(mandate, req, history, now),
  ];
}
