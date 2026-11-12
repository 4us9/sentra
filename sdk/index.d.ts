export type Verdict = 'ALLOW' | 'BLOCK' | 'REVIEW' | 'ERROR';
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
  mode: 'sandbox' | 'test' | 'simulated';
  /** The processor's record was read back and matches what was approved. */
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
    idempotencyKey: string | null;
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
  constructor(message: string, status: number);
}

export class PaymentRefused extends Error {
  decision: Decision;
  verdict: Verdict;
  constructor(decision: Decision);
}

export class Sentra {
  constructor(options: SentraOptions);
  /** Resolves with the decision for every verdict; rejects only on transport or auth failure. */
  guard(payment: PaymentRequest): Promise<Decision>;
  /** Rejects with PaymentRefused unless the verdict is ALLOW. */
  guardOrThrow(payment: PaymentRequest): Promise<Decision>;
  mandate(): Promise<Mandate>;
  /** Wrap a payment function so it only runs after Sentra allows the payment. */
  protect<T>(fn: (payment: PaymentRequest, decision: Decision) => Promise<T> | T): (payment: PaymentRequest) => Promise<T>;
}

export default Sentra;
