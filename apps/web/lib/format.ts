import type { Decision, Reason } from './types';

const BAD = new Set(['FAIL', 'FLAG', 'high', 'med', 'error']);

/** Anything from the API -> a bounded display string. Never trusted, only displayed. */
export function str(v: unknown, max = 600): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); } }
  return s.length > max ? s.slice(0, max) + '...' : s;
}
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function money(v: unknown, currency?: string): string {
  if (!isNum(v)) return str(v, 60) || '(none)';
  const cur = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(v); }
  catch { return '$' + v.toFixed(2); }
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? str(iso, 30) : d.toLocaleTimeString('en-GB', { hour12: false });
}
export function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? str(iso, 30) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
export function shortHash(h: unknown): string {
  const s = str(h, 200);
  return s.length > 30 ? `${s.slice(0, 14)}...${s.slice(-8)}` : s || '-';
}

/** Characters outside printable ASCII in an agent-supplied string, for the "look-alike" callout. */
export function nonAscii(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length && out.length < 8; i++) {
    const c = s.charCodeAt(i);
    if (c > 126 || c < 32) out.push(`U+${c.toString(16).toUpperCase().padStart(4, '0')} at position ${i + 1}`);
  }
  return out;
}

export function remaining(iso: string): { text: string; expired: boolean } {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { text: 'unknown', expired: false };
  const ms = t - Date.now();
  if (ms <= 0) return { text: 'expired', expired: true };
  const mins = Math.floor(ms / 60000), h = Math.floor(mins / 60), d = Math.floor(h / 24);
  if (d >= 2) return { text: `in ${d} days`, expired: false };
  if (h >= 1) return { text: `in ${h}h ${mins % 60}m`, expired: false };
  return { text: `in ${Math.max(mins, 1)} min`, expired: false };
}

/** The reason that stopped a payment: decidedBy, else the first failing reason. */
export function decidingReason(d: Decision): Reason | null {
  const rs = Array.isArray(d.reasons) ? d.reasons : [];
  const by = d.decidedBy;
  if (by && typeof by === 'object') {
    return rs.find((r) => r && r.layer === by.layer && r.check === by.check) ?? { layer: by.layer, check: by.check, detail: '', result: '' };
  }
  if (d.verdict === 'ALLOW') return null;
  return rs.find((r) => r && BAD.has(r.result)) ?? null;
}

/** Intent details end with the source in brackets: "... [llm]", "[signature]", "[fallback]". */
export function splitSource(detail: string): { text: string; source: string } {
  const t = str(detail, 600);
  const m = /^([\s\S]*?)\s*\[([a-z_]{2,16})\]$/.exec(t);
  return m ? { text: m[1] ?? '', source: m[2] ?? '' } : { text: t, source: '' };
}

export function decidingText(d: Decision): string {
  const r = decidingReason(d);
  if (r) return str(r.check, 80) + (r.detail ? ': ' + str(r.detail, 400) : '');
  const first = Array.isArray(d.reasons) ? d.reasons[0] : null;
  if (d.kind === 'event') return first ? str(first.detail, 400) : 'operator event';
  if (d.kind === 'review_resolution' && first) return `${str(first.check, 80)}: ${str(first.detail, 400)}`;
  return 'all checks passed';
}

export function pendingReviews(decisions: Decision[]): Decision[] {
  const resolved = new Set(decisions.map((d) => d.resolves).filter(Boolean));
  return decisions.filter((d) => d.verdict === 'REVIEW' && !resolved.has(d.id));
}

export const LAYER_LABEL: Record<string, string> = {
  schema: 'Schema', rule: 'Rules', anomaly: 'Anomaly', intent: 'Intent', human: 'Human', processor: 'Processor',
};
export const CORE_LAYERS = ['schema', 'rule', 'anomaly', 'intent'] as const;
export const layerName = (k: string) => LAYER_LABEL[k] ?? (str(k, 30) || 'Other');

export function procShort(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, '') || label;
}
