// The audit ledger as a product surface: query it, export it, measure it.
// Everything here is read-only and derived from the append-only, hash-chained
// decisions in the store.

import type { Decision, Mandate, Metrics } from './types.js';

export interface LedgerQuery {
  /** ALLOW | BLOCK | REVIEW | ERROR | INFO (comma-separated allowed) */
  verdict?: string;
  /** payment | review_resolution | event (comma-separated allowed) */
  kind?: string;
  /** mandate id */
  mandate?: string;
  /** layer that decided: schema | rule | anomaly | intent | human | processor */
  layer?: string;
  /** check that decided, e.g. per_tx_cap */
  check?: string;
  /** paypal | stripe */
  processor?: string;
  /** ISO time, inclusive */
  since?: string;
  /** ISO time, exclusive */
  until?: string;
  /** substring match on recipient, purpose, payment id, decision id */
  q?: string;
  limit?: string | number;
  offset?: string | number;
}

const list = (v: unknown): string[] => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function queryLedger(decisions: Decision[], query: LedgerQuery = {}): { total: number; offset: number; limit: number; entries: Decision[] } {
  const verdicts = list(query.verdict).map((s) => s.toUpperCase());
  const kinds = list(query.kind);
  const since = query.since ? Date.parse(query.since) : null;
  const until = query.until ? Date.parse(query.until) : null;
  const q = String(query.q || '').toLowerCase();
  const rows = decisions.filter((d) => {
    if (verdicts.length && !verdicts.includes(d.verdict)) return false;
    if (kinds.length && !kinds.includes(d.kind)) return false;
    if (query.mandate && d.mandateId !== query.mandate) return false;
    if (query.layer && d.decidedBy?.layer !== query.layer) return false;
    if (query.check && d.decidedBy?.check !== query.check) return false;
    if (query.processor && d.processor !== query.processor) return false;
    const t = Date.parse(d.createdAt);
    if (since !== null && !Number.isNaN(since) && t < since) return false;
    if (until !== null && !Number.isNaN(until) && t >= until) return false;
    if (q) {
      const hay = [d.id, d.paymentId, d.request?.recipient, d.request?.purpose].map((x) => String(x ?? '').toLowerCase());
      if (!hay.some((h) => h.includes(q))) return false;
    }
    return true;
  });
  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = Math.min(5000, Math.max(1, Number(query.limit) || 500));
  return { total: rows.length, offset, limit, entries: rows.slice(offset, offset + limit) };
}

const COLUMNS: Array<[string, (d: Decision) => unknown]> = [
  ['seq', (d) => d.seq], ['time', (d) => d.createdAt], ['decision_id', (d) => d.id], ['kind', (d) => d.kind],
  ['mandate', (d) => d.mandateId], ['processor', (d) => d.processor ?? ''], ['verdict', (d) => d.verdict],
  ['decided_by_layer', (d) => d.decidedBy?.layer ?? ''], ['decided_by_check', (d) => d.decidedBy?.check ?? ''],
  ['why', (d) => { const r = (d.reasons || []).find((x) => x.layer === d.decidedBy?.layer && x.check === d.decidedBy?.check); return r ? r.detail : ''; }],
  ['amount', (d) => d.request?.amount ?? ''], ['currency', (d) => d.request?.currency ?? ''],
  ['recipient', (d) => d.request?.recipient ?? ''], ['purpose', (d) => d.request?.purpose ?? ''],
  ['risk_score', (d) => d.riskScore ?? ''], ['intent_source', (d) => d.intentSource ?? ''],
  ['payment_id', (d) => d.paymentId ?? ''], ['payment_mode', (d) => d.payment?.mode ?? ''],
  ['latency_ms', (d) => d.latencyMs ?? ''], ['resolves', (d) => d.resolves ?? ''],
  ['prev_hash', (d) => d.prevHash], ['hash', (d) => d.hash],
];

// The ledger holds attacker-supplied text. A cell that starts with = + - @ (or a tab /
// CR) would be run as a formula when an auditor opens the export in a spreadsheet,
// so those are neutralised with a leading apostrophe.
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(entries: Decision[]): string {
  return [COLUMNS.map(([h]) => h).join(','), ...entries.map((d) => COLUMNS.map(([, f]) => csvCell(f(d))).join(','))].join('\r\n') + '\r\n';
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Aggregate metrics over the ledger and current mandates. */
export function computeMetrics(decisions: Decision[], mandates: Array<Pick<Mandate, 'status'>>, { reserved = 0 }: { reserved?: number } = {}): Metrics {
  const payments = decisions.filter((d) => d.kind !== 'event');
  const byVerdict: Metrics['byVerdict'] = { ALLOW: 0, BLOCK: 0, REVIEW: 0, ERROR: 0 };
  const byLayer: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  const spend: Record<string, number> = {};
  const blockedValue = { total: 0 };
  for (const d of payments) {
    if (d.verdict in byVerdict) byVerdict[d.verdict as keyof Metrics['byVerdict']]++;
    if (d.verdict !== 'ALLOW' && d.decidedBy) {
      byLayer[d.decidedBy.layer] = (byLayer[d.decidedBy.layer] || 0) + 1;
      byCheck[d.decidedBy.check] = (byCheck[d.decidedBy.check] || 0) + 1;
    }
    const amt = typeof d.request?.amount === 'number' && Number.isFinite(d.request.amount) && d.request.amount > 0 ? d.request.amount : 0;
    if (d.verdict === 'ALLOW') spend[d.processor || 'unknown'] = Math.round(((spend[d.processor || 'unknown'] || 0) + amt) * 100) / 100;
    if (d.verdict === 'BLOCK' && d.kind === 'payment') blockedValue.total = Math.round((blockedValue.total + amt) * 100) / 100;
  }
  const lat = payments.filter((d) => d.kind === 'payment' && Number.isFinite(d.latencyMs)).map((d) => d.latencyMs as number).sort((a, b) => a - b);
  const decided = byVerdict.ALLOW + byVerdict.BLOCK + byVerdict.REVIEW + byVerdict.ERROR;
  const resolved = new Set(decisions.filter((d) => d.resolves).map((d) => d.resolves));
  return {
    decisions: decided,
    byVerdict,
    blockRate: decided ? Math.round((byVerdict.BLOCK / decided) * 10000) / 10000 : 0,
    stoppedByLayer: byLayer,
    stoppedByCheck: byCheck,
    spendByProcessor: spend,
    spendTotal: Math.round(Object.values(spend).reduce((a, b) => a + b, 0) * 100) / 100,
    blockedValue: blockedValue.total,
    reservedInFlight: reserved,
    reviewsPending: decisions.filter((d) => d.verdict === 'REVIEW' && !resolved.has(d.id)).length,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat[lat.length - 1] || 0, samples: lat.length },
    mandates: { total: mandates.length, frozen: mandates.filter((m) => m.status === 'frozen').length },
  };
}

/** Prometheus text exposition format. */
export function toPrometheus(m: Metrics, audit: { length: number; ok: boolean }): string {
  const out: string[] = [];
  const metric = (name: string, help: string, type: string, rows: Array<[Record<string, string>, number]>): void => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, '_')}"`).join(',');
      out.push(`${name}${l ? `{${l}}` : ''} ${value}`);
    }
  };
  metric('sentra_decisions_total', 'Payment decisions by verdict.', 'counter', Object.entries(m.byVerdict).map(([v, n]) => [{ verdict: v }, n]));
  metric('sentra_stopped_total', 'Payments stopped, by the layer that decided.', 'counter', Object.entries(m.stoppedByLayer).map(([l, n]) => [{ layer: l }, n]));
  metric('sentra_block_rate', 'Share of decisions that were BLOCK.', 'gauge', [[{}, m.blockRate]]);
  metric('sentra_spend_total', 'Value of allowed payments, by processor.', 'counter', Object.entries(m.spendByProcessor).map(([p, n]) => [{ processor: p }, n]));
  metric('sentra_blocked_value_total', 'Value of blocked payment attempts.', 'counter', [[{}, m.blockedValue]]);
  metric('sentra_reserved_in_flight', 'Value currently reserved by in-flight payments.', 'gauge', [[{}, m.reservedInFlight]]);
  metric('sentra_reviews_pending', 'Held payments waiting for a human.', 'gauge', [[{}, m.reviewsPending]]);
  metric('sentra_decision_latency_ms', 'Decision latency in milliseconds.', 'gauge', [[{ quantile: '0.5' }, m.latencyMs.p50], [{ quantile: '0.95' }, m.latencyMs.p95]]);
  metric('sentra_mandates', 'Mandates by state.', 'gauge', [[{ state: 'frozen' }, m.mandates.frozen], [{ state: 'active' }, m.mandates.total - m.mandates.frozen]]);
  metric('sentra_ledger_entries', 'Entries in the audit ledger.', 'gauge', [[{}, audit.length]]);
  metric('sentra_ledger_intact', '1 if the audit hash chain verifies, 0 if it has been tampered with.', 'gauge', [[{}, audit.ok ? 1 : 0]]);
  return out.join('\n') + '\n';
}
