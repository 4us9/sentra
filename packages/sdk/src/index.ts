// Sentra client SDK. Zero dependencies; works in Node 18+, Bun, Deno and browsers.
//
//   import { Sentra } from '@sentra/sdk';
//   const sentra = new Sentra({ url: process.env.SENTRA_URL, agentToken: process.env.SENTRA_AGENT_TOKEN! });
//
//   const decision = await sentra.guard({ amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' });
//   if (decision.verdict === 'ALLOW') { /* paid: decision.paymentId */ }
//
// The agent token identifies the mandate, so there is no mandate argument: an agent
// cannot choose which mandate it is judged against.

/** INFO only appears on operator events (kind 'event') in the ledger, never as the answer to guard(). */
export type Verdict = 'ALLOW' | 'BLOCK' | 'REVIEW' | 'ERROR' | 'INFO';
export type Layer = 'schema' | 'rule' | 'anomaly' | 'intent' | 'human' | 'processor';

export interface PaymentRequest {
  /** Major units, at most 2 decimals. A number or a plain decimal string. */
  amount: number | string;
  /** Recipient id exactly as listed in the mandate. */
  recipient: string;
  /** What the payment is for, in plain words. Judged by the intent layer. */
  purpose: string;
  /** ISO 4217. Defaults to the mandate's currency. */
  currency?: string;
  /** Reuse the same key when retrying; the payment is executed at most once. */
  idempotencyKey?: string;
}

export interface Reason {
  layer: Layer;
  check: string;
  /** pass | ok | low mean fine. FAIL | FLAG | high | med | error stopped the payment. */
  result: 'pass' | 'FAIL' | 'ok' | 'FLAG' | 'low' | 'med' | 'high' | 'error' | 'info';
  detail: string;
}

export interface PaymentResult {
  processor: string;
  id: string;
  status: string;
  /** 'external' = Sentra authorised only; the caller executes the payment itself. */
  mode: 'sandbox' | 'test' | 'simulated' | 'external';
  /** The processor's record was read back and matches what was approved. Always false for 'external'. */
  verified: boolean;
}

export interface Decision {
  id: string;
  seq: number;
  kind: 'payment' | 'review_resolution' | 'event';
  mandateId: string;
  processor: string;
  verdict: Verdict;
  /** Every check that ran, in order. */
  reasons: Reason[];
  /** The first check that stopped the payment, or null for ALLOW. */
  decidedBy: { layer: Layer; check: string } | null;
  riskScore: number;
  intentSource: 'llm' | 'fallback' | 'signature' | 'skipped' | 'human' | string;
  request: {
    amount: number | string;
    currency: string;
    recipient: string;
    purpose: string;
    idempotencyKey?: string | null;
  };
  payment: PaymentResult | null;
  paymentId: string | null;
  createdAt: string;
  latencyMs: number;
  /** For a review resolution: the id of the held decision it resolves. */
  resolves: string | null;
  effects: Array<'mandate_frozen' | 'mandate_reinstated'>;
  /** True when this is the stored result of an earlier request with the same idempotencyKey. */
  replayed?: boolean;
  prevHash: string;
  hash: string;
}

export interface Mandate {
  id: string;
  user: string;
  /** Name of the policy file this mandate was issued from, if any. */
  policy: string | null;
  description: string;
  scope: string[];
  processor: string;
  currency: string;
  budgetTotal: number;
  perTxCap: number;
  allowedRecipients: string[];
  velocityLimit: { count: number; windowSec: number };
  breaker: { blocks: number; windowSec: number };
  outOfScope: 'review' | 'block';
  expiresAt: string;
  createdAt: string;
  spent: number;
  status: 'active' | 'frozen';
  frozenReason: string | null;
  breakerResetAt: string | null;
  /** Amount held by payments that are in flight. Present on /api/state. */
  reserved?: number;
  sealValid: boolean;
}

export interface SentraOptions {
  /** Where Sentra runs. Default http://localhost:3000 */
  url?: string;
  /** The mandate-scoped token issued when the mandate was created. */
  agentToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class SentraError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SentraError';
    this.status = status;
  }
}

/** Thrown by guardOrThrow when a payment is not allowed. Carries the full decision. */
export class PaymentRefused extends Error {
  decision: Decision;
  verdict: Verdict;
  constructor(decision: Decision) {
    const why = (decision.reasons || []).find((r) => ['FAIL', 'FLAG', 'high', 'med', 'error'].includes(r.result));
    super(`payment ${decision.verdict}${why ? `: ${why.check}: ${why.detail}` : ''}`);
    this.name = 'PaymentRefused';
    this.decision = decision;
    this.verdict = decision.verdict;
  }
}

export class Sentra {
  readonly url: string;
  readonly timeoutMs: number;
  private readonly _token: string;
  private readonly _fetch: typeof fetch;

  constructor(options: SentraOptions) {
    const { url = 'http://localhost:3000', agentToken, fetch: fetchImpl, timeoutMs = 60_000 } = options ?? ({} as Partial<SentraOptions>);
    if (!agentToken) throw new SentraError('agentToken is required', 0);
    this.url = String(url).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._token = agentToken;
    this._fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  /** The parsed JSON answer from Sentra; the public methods give it its type. */
  private async _call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this._fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    if (!r.ok) throw new SentraError(j.error || `Sentra returned ${r.status}`, r.status);
    return j as T;
  }

  /** Resolves with the decision for every verdict; rejects only on transport or auth failure. */
  guard(payment: PaymentRequest): Promise<Decision> {
    return this._call<Decision>('POST', '/guard', payment);
  }

  /** Rejects with PaymentRefused unless the verdict is ALLOW. */
  async guardOrThrow(payment: PaymentRequest): Promise<Decision> {
    const decision = await this.guard(payment);
    if (decision.verdict !== 'ALLOW') throw new PaymentRefused(decision);
    return decision;
  }

  /** What this agent is allowed to do: budget, cap, recipients, status. */
  mandate(): Promise<Mandate> {
    return this._call<Mandate>('GET', '/guard/mandate');
  }

  /**
   * Wrap an existing payment function so it can only run after Sentra allows it.
   * The wrapped function receives the same payment plus the decision.
   */
  protect<T>(fn: (payment: PaymentRequest, decision: Decision) => Promise<T> | T): (payment: PaymentRequest) => Promise<T> {
    return async (payment) => fn(payment, await this.guardOrThrow(payment));
  }
}

export default Sentra;
