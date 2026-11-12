// Structured decision log line (one JSON line per decision). This module only
// formats; the caller decides where the line goes.
//
// Logs are the easiest place to leak things, so this never emits: tokens, keys,
// the Authorization header, or the raw purpose text. The purpose is attacker-
// controlled free text and may also carry personal data; logs get its length and a
// short fingerprint, which is enough to correlate with the ledger entry.
import crypto from 'node:crypto';
import type { Decision } from './types.js';

/** Length + fingerprint, never the text itself. */
export function redactText(text: unknown): { len: number; sha256_8?: string } {
  const s = String(text ?? '');
  if (!s) return { len: 0 };
  return { len: s.length, sha256_8: crypto.createHash('sha256').update(s).digest('hex').slice(0, 8) };
}

const SECRET_SHAPES: RegExp[] = [
  /\bsat_[A-Za-z0-9_-]{8,}/g,                // Sentra agent tokens
  /\bsk_sentra_[A-Za-z0-9_-]{8,}/g,          // Sentra operator API keys
  /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]{8,}/g, // Stripe keys
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,             // Anthropic keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bA21AA[A-Za-z0-9_-]{8,}/g,               // PayPal access tokens
];

/** Scrub anything shaped like a credential out of a string before it is logged or stored. */
export function scrubSecrets(text: unknown): string {
  let s = String(text ?? '');
  for (const re of SECRET_SHAPES) s = s.replace(re, '[redacted]');
  return s;
}

/** The single log line for a decision (no trailing newline). */
export function formatDecisionLog(d: Decision): string {
  const line = {
    t: d.createdAt, event: 'decision', seq: d.seq, id: d.id, kind: d.kind, mandate: d.mandateId,
    verdict: d.verdict, layer: d.decidedBy?.layer ?? null, check: d.decidedBy?.check ?? null,
    amount: typeof d.request?.amount === 'number' ? d.request.amount : null,
    currency: d.request?.currency ?? null,
    recipient: scrubSecrets(String(d.request?.recipient ?? '').slice(0, 64)),
    purpose: redactText(d.request?.purpose),
    processor: d.processor, paymentId: d.paymentId ?? null, mode: d.payment?.mode ?? null,
    intent: d.intentSource, latencyMs: d.latencyMs ?? null, effects: d.effects?.length ? d.effects : undefined,
  };
  return JSON.stringify(line);
}
