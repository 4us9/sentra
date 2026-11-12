// Layer 1: deterministic hard rules. Each returns { name, pass, detail }.
// Exact, fast, no AI. Money is compared in integer cents so floating point can
// never round a payment under a limit.
import { toCents } from './validate.js';
import { sealValid } from '../mandate.js';

export function mandateIntegrity(mandate) {
  const pass = sealValid(mandate);
  return { name: 'mandate_integrity', pass, detail: pass ? 'seal verified' : 'mandate seal does NOT verify: policy was modified after issue' };
}

export function mandateActive(mandate) {
  const pass = mandate.status !== 'frozen';
  return { name: 'mandate_active', pass, detail: pass ? 'active' : `frozen: ${mandate.frozenReason || 'by operator'}` };
}

export function expiry(mandate, req, now = Date.now()) {
  const pass = now < new Date(mandate.expiresAt).getTime();
  return { name: 'expiry', pass, detail: `mandate expires ${mandate.expiresAt}` };
}

export function currency(mandate, req) {
  const pass = req.currency === mandate.currency;
  return { name: 'currency', pass, detail: `${req.currency} vs mandate ${mandate.currency}` };
}

export function perTxCap(mandate, req) {
  const pass = toCents(req.amount) <= toCents(mandate.perTxCap);
  return { name: 'per_tx_cap', pass, detail: `amount ${req.amount} vs cap ${mandate.perTxCap}` };
}

export function budget(mandate, req) {
  const pass = toCents(mandate.spent) + toCents(req.amount) <= toCents(mandate.budgetTotal);
  return { name: 'budget', pass, detail: `spent ${mandate.spent} + ${req.amount} vs total ${mandate.budgetTotal}` };
}

export function recipientAllowlist(mandate, req) {
  const pass = mandate.allowedRecipients.includes(req.recipient);
  return { name: 'recipient_allowlist', pass, detail: `recipient ${req.recipient} ${pass ? 'in' : 'NOT in'} allowlist` };
}

export function velocity(mandate, req, history, now = Date.now()) {
  const { count, windowSec } = mandate.velocityLimit;
  const recent = history.filter(
    (d) => d.verdict === 'ALLOW' && (now - new Date(d.createdAt).getTime()) <= windowSec * 1000
  );
  const pass = recent.length < count;
  return { name: 'velocity', pass, detail: `${recent.length} allowed in last ${windowSec}s vs limit ${count}` };
}

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
