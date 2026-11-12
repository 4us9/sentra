// Layer 2: behavioural anomaly checks over the mandate's own history.
// Each returns { name, flag, detail }. flag=true means suspicious.
import type { AnomalyResult, HistoryEntry, Mandate, NormalizedRequest } from '../types.js';

export function amountSpike(mandate: Mandate, req: NormalizedRequest, history: HistoryEntry[]): AnomalyResult {
  const allowed = history.filter((d) => d.verdict === 'ALLOW').map((d) => Number(d.request.amount));
  if (allowed.length < 3) return { name: 'amount_spike', flag: false, detail: 'insufficient history' };
  const avg = allowed.reduce((a, b) => a + b, 0) / allowed.length;
  const flag = Number(req.amount) > 5 * Math.max(avg, 1);
  return { name: 'amount_spike', flag, detail: `amount ${req.amount} vs 5x avg ${(5 * avg).toFixed(2)}` };
}

export function drainPattern(mandate: Mandate, req: NormalizedRequest, history: HistoryEntry[], now: number = Date.now()): AnomalyResult {
  const recent = history.filter(
    (d) => d.verdict === 'ALLOW' && (now - new Date(d.createdAt).getTime()) <= 30 * 1000
  );
  const sum = recent.reduce((a, d) => a + Number(d.request.amount), 0) + Number(req.amount);
  const flag = sum > 0.8 * mandate.budgetTotal && recent.length >= 3;
  return { name: 'drain_pattern', flag, detail: `~${sum.toFixed(2)} in last 30s vs 80% budget ${(0.8 * mandate.budgetTotal).toFixed(2)}` };
}

export function runAnomaly(mandate: Mandate, req: NormalizedRequest, history: HistoryEntry[], now: number = Date.now()): AnomalyResult[] {
  return [amountSpike(mandate, req, history), drainPattern(mandate, req, history, now)];
}
