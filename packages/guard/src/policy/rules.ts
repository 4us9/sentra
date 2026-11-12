// Layer 1: deterministic hard rules. Each returns { name, pass, detail }.
// Exact, fast, no AI. Money is compared in integer cents so floating point can
// never round a payment under a limit.
import { toCents } from './validate.js';
import { sealValid } from '../mandate.js';
import type { HistoryEntry, Mandate, NormalizedRequest, RuleResult } from '../types.js';

export function mandateIntegrity(mandate: Mandate): RuleResult {
  const pass = sealValid(mandate);
  return { name: 'mandate_integrity', pass, detail: pass ? 'seal verified' : 'mandate seal does NOT verify: policy was modified after issue' };
}

export function mandateActive(mandate: Mandate): RuleResult {
  const pass = mandate.status !== 'frozen';
  return { name: 'mandate_active', pass, detail: pass ? 'active' : `frozen: ${mandate.frozenReason || 'by operator'}` };
}

export function expiry(mandate: Mandate, req: NormalizedRequest, now: number = Date.now()): RuleResult {
  const pass = now < new Date(mandate.expiresAt).getTime();
  return { name: 'expiry', pass, detail: `mandate expires ${mandate.expiresAt}` };
}

export function currency(mandate: Mandate, req: NormalizedRequest): RuleResult {
  const pass = req.currency === mandate.currency;
  return { name: 'currency', pass, detail: `${req.currency} vs mandate ${mandate.currency}` };
}

export function perTxCap(mandate: Mandate, req: NormalizedRequest): RuleResult {
  const pass = toCents(req.amount) <= toCents(mandate.perTxCap);
  return { name: 'per_tx_cap', pass, detail: `amount ${req.amount} vs cap ${mandate.perTxCap}` };
}

// `reserved` is money already promised to payments that are in flight (approved, not
// yet settled). Counting it here is what closes the double-spend race.
export function budget(mandate: Mandate, req: NormalizedRequest): RuleResult {
  const reserved = mandate.reserved || 0;
  const pass = toCents(mandate.spent) + toCents(reserved) + toCents(req.amount) <= toCents(mandate.budgetTotal);
  const held = reserved ? ` + ${reserved} reserved` : '';
  return { name: 'budget', pass, detail: `spent ${mandate.spent}${held} + ${req.amount} vs total ${mandate.budgetTotal}` };
}

export function recipientAllowlist(mandate: Mandate, req: NormalizedRequest): RuleResult {
  const pass = mandate.allowedRecipients.includes(req.recipient);
  return { name: 'recipient_allowlist', pass, detail: `recipient ${req.recipient} ${pass ? 'in' : 'NOT in'} allowlist` };
}

export function velocity(mandate: Mandate, req: NormalizedRequest, history: HistoryEntry[], now: number = Date.now()): RuleResult {
  const { count, windowSec } = mandate.velocityLimit;
  const recent = history.filter(
    (d) => d.verdict === 'ALLOW' && (now - new Date(d.createdAt).getTime()) <= windowSec * 1000
  );
  const pass = recent.length < count;
  return { name: 'velocity', pass, detail: `${recent.length} allowed in last ${windowSec}s vs limit ${count}` };
}

export function runHardRules(mandate: Mandate, req: NormalizedRequest, history: HistoryEntry[], now: number = Date.now()): RuleResult[] {
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
