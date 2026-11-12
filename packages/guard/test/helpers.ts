import { createMandate } from '../src/index.js';
import type { HistoryEntry, Mandate, MandateInput, Outcome, SemanticFn } from '../src/index.js';

export const now = Date.parse('2026-11-12T12:00:00Z');
export const low: SemanticFn = async () => ({ risk: 'low', reason: 'stub', source: 'stub' });
export const med: SemanticFn = async () => ({ risk: 'med', reason: 'stub', source: 'stub' });
export const high: SemanticFn = async () => ({ risk: 'high', reason: 'stub', source: 'stub' });
export const none: SemanticFn = async () => null;                       // "no model configured"

export const mandate = (partial: MandateInput = {}, extra: Partial<Mandate> = {}): Mandate =>
  ({ ...createMandate({ id: 'm', ...partial }, now).mandate, ...extra });

export const ok = { amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' };

export const allowed = (n: number, { amount = 20, ageMs = 1000 } = {}): HistoryEntry[] => Array.from({ length: n }, () => ({
  mandateId: 'm', verdict: 'ALLOW' as const, request: { amount }, createdAt: new Date(now - ageMs).toISOString(),
}));

export const failed = (out: Outcome): string[] =>
  out.reasons.filter((r) => ['FAIL', 'FLAG', 'high'].includes(r.result)).map((r) => r.check);
