// Layer 2: behavioural anomaly checks over the mandate's own history.
// Each returns { name, flag, detail }. flag=true means suspicious.

/**
 * @typedef {import('../types.js').Mandate} Mandate
 * @typedef {import('../types.js').NormalizedRequest} NormalizedRequest
 * @typedef {import('../types.js').HistoryEntry} HistoryEntry
 * @typedef {import('../types.js').AnomalyResult} AnomalyResult
 */

/** @param {Mandate} mandate @param {NormalizedRequest} req @param {HistoryEntry[]} history @returns {AnomalyResult} */
export function amountSpike(mandate, req, history) {
  const allowed = history.filter((d) => d.verdict === 'ALLOW').map((d) => Number(d.request.amount));
  if (allowed.length < 3) return { name: 'amount_spike', flag: false, detail: 'insufficient history' };
  const avg = allowed.reduce((a, b) => a + b, 0) / allowed.length;
  const flag = Number(req.amount) > 5 * Math.max(avg, 1);
  return { name: 'amount_spike', flag, detail: `amount ${req.amount} vs 5x avg ${(5 * avg).toFixed(2)}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @param {HistoryEntry[]} history @param {number} [now] @returns {AnomalyResult} */
export function drainPattern(mandate, req, history, now = Date.now()) {
  const recent = history.filter(
    (d) => d.verdict === 'ALLOW' && (now - new Date(d.createdAt).getTime()) <= 30 * 1000
  );
  const sum = recent.reduce((a, d) => a + Number(d.request.amount), 0) + Number(req.amount);
  const flag = sum > 0.8 * mandate.budgetTotal && recent.length >= 3;
  return { name: 'drain_pattern', flag, detail: `~${sum.toFixed(2)} in last 30s vs 80% budget ${(0.8 * mandate.budgetTotal).toFixed(2)}` };
}

/** @param {Mandate} mandate @param {NormalizedRequest} req @param {HistoryEntry[]} history @param {number} [now] @returns {AnomalyResult[]} */
export function runAnomaly(mandate, req, history, now = Date.now()) {
  return [amountSpike(mandate, req, history), drainPattern(mandate, req, history, now)];
}
