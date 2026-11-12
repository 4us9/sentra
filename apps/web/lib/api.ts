import { API_BASE } from './env';
import type {
  ChainStatus, Decision, Health, LedgerResponse, Mandate, PaymentInput, Policy, Scenario, ServiceState,
} from './types';

export const ADMIN_KEY = 'sentra.adminToken';
const TOKEN_PREFIX = 'sentra.agentToken.';

export interface ApiResult<T> { status: number; body: T }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSec?: number) {
    super(message);
  }
}

// ---- sessionStorage: tokens live only in this tab, never in a URL ----
function ss(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
export const operatorToken = () => ss()?.getItem(ADMIN_KEY) ?? null;
export const setOperatorToken = (t: string) => { if (t) ss()?.setItem(ADMIN_KEY, t); else ss()?.removeItem(ADMIN_KEY); };
export const agentTokenFor = (mandateId: string) => ss()?.getItem(TOKEN_PREFIX + mandateId) ?? null;
export const storeAgentToken = (mandateId: string, token: string) => ss()?.setItem(TOKEN_PREFIX + mandateId, token);
export function agentTokenIds(): string[] {
  const s = ss(); const out: string[] = [];
  if (!s) return out;
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(TOKEN_PREFIX)) out.push(k.slice(TOKEN_PREFIX.length)); }
  return out;
}
export function dropAgentTokens() { for (const id of agentTokenIds()) ss()?.removeItem(TOKEN_PREFIX + id); }

// ---- transport ----
async function request<T>(method: 'GET' | 'POST', path: string, opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (method === 'POST') headers['content-type'] = 'application/json';
  const res = await fetch(API_BASE + path, {
    method, headers, cache: 'no-store', signal: opts.signal,
    body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

const errText = (b: unknown, status: number) => {
  const e = (b as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e.slice(0, 200) : `HTTP ${status}`;
};
const retry = (b: unknown) => {
  const n = (b as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  return typeof n === 'number' ? Math.max(1, Math.ceil(n)) : undefined;
};

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await request<T>('GET', path, { signal });
  if (r.status < 200 || r.status >= 300) throw new ApiError(errText(r.body, r.status), r.status);
  return r.body;
}

/** Operator write. Sends x-sentra-admin when the operator has stored a token (Settings). */
async function opPost<T>(path: string, body: unknown = {}): Promise<T> {
  const t = operatorToken();
  const r = await request<T>('POST', path, { body, headers: t ? { 'x-sentra-admin': t } : {} });
  if (r.status === 401) throw new ApiError('Operator token required or rejected. Set it in Settings.', 401);
  if (r.status === 429) {
    const s = retry(r.body);
    throw new ApiError(`Operator rate limit reached. Retry in ${s ?? 'a few'} seconds.`, 429, s);
  }
  if (r.status < 200 || r.status >= 300) throw new ApiError(errText(r.body, r.status), r.status);
  return r.body;
}

// ---- read surface ----
export const getState = (signal?: AbortSignal) => read<ServiceState>('/api/state', signal);
export const getPolicies = () => read<{ policies: Policy[]; default: string | null }>('/api/policies');
export const getScenarios = () => read<{ scenarios: Scenario[]; poisonedListing: string }>('/api/scenarios');
export const getHealth = () => read<Health>('/health');
export const getAudit = () => read<ChainStatus>('/api/audit/verify');
export const getLedger = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return read<LedgerResponse>('/api/ledger?' + p.toString());
};
export async function downloadLedgerCsv(q: Record<string, string | undefined> = {}) {
  const p = new URLSearchParams({ format: 'csv' });
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const res = await fetch(`${API_BASE}/api/ledger?${p}`, { cache: 'no-store' });
  if (!res.ok) throw new ApiError(`CSV export failed (HTTP ${res.status})`, res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = 'sentra-ledger.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- operator surface ----
export const issueMandate = (input: { policy?: string; processor?: string }) =>
  opPost<{ mandate: Mandate; agentToken: string }>('/api/mandates', input);
export const freezeMandate = (id: string) => opPost<Mandate>(`/api/mandates/${encodeURIComponent(id)}/freeze`);
export const reinstateMandate = (id: string) => opPost<Mandate>(`/api/mandates/${encodeURIComponent(id)}/reinstate`);
export const resolveReview = (id: string, action: 'approve' | 'deny') =>
  opPost<Decision>(`/api/reviews/${encodeURIComponent(id)}/${action}`);

// ---- agent surface (exactly what an agent would send) ----
export type GuardOutcome =
  | { kind: 'decision'; decision: Decision }
  | { kind: 'rate'; retryAfterSec?: number }
  | { kind: 'auth' }
  | { kind: 'error'; message: string };

export async function guard(token: string, payment: PaymentInput): Promise<GuardOutcome> {
  const r = await request<Decision & { error?: string }>('POST', '/guard', { body: payment, headers: { authorization: `Bearer ${token}` } });
  if (r.status === 401) return { kind: 'auth' };
  if (r.status === 429) return { kind: 'rate', retryAfterSec: retry(r.body) };
  if (r.status !== 200 || !r.body?.id) return { kind: 'error', message: errText(r.body, r.status) };
  return { kind: 'decision', decision: r.body };
}
