// Shared domain types for Sentra's server side. Type-only: nothing here exists at
// runtime. The .js sources reference these through JSDoc (`import('./types.js')`).
//
// sdk/index.d.ts stays the public client surface. These are deliberately richer:
// they include the server-only fields (credential hash, seal, in-flight reservation)
// and the ledger-only verdict 'INFO'.
//
// The processor contract (PaymentRequest / PaymentResult / PaymentProcessor) is
// defined once, next to the code that implements it, and re-exported from here.
import type {
  PaymentRequest as ProcessorPaymentRequest,
  PaymentResult,
  PaymentProcessor,
} from './processors/index.js';

export type { ProcessorPaymentRequest, PaymentResult, PaymentProcessor };
export type ProcessorMode = PaymentResult['mode'];

// ---------------------------------------------------------------- mandate ----

export interface VelocityLimit { count: number; windowSec: number }
export interface Breaker { blocks: number; windowSec: number }

/** The fields covered by the mandate's HMAC seal (SEALED_FIELDS in src/mandate.js). */
export type SealedField =
  | 'id' | 'user' | 'policy' | 'description' | 'scope' | 'processor' | 'currency' | 'budgetTotal' | 'perTxCap'
  | 'allowedRecipients' | 'velocityLimit' | 'breaker' | 'outOfScope' | 'expiresAt' | 'tokenHash' | 'createdAt';

export interface Mandate {
  id: string;
  user: string;
  /** Name of the policy file this mandate was issued from, if any. */
  policy: string | null;
  description: string;
  scope: string[];
  /** Which rail executes an ALLOW. */
  processor: string;
  currency: string;
  budgetTotal: number;
  perTxCap: number;
  allowedRecipients: string[];
  velocityLimit: VelocityLimit;
  /** Circuit breaker: this many BLOCKs inside the window freezes the mandate. */
  breaker: Breaker;
  outOfScope: 'review' | 'block';
  /** ISO time. */
  expiresAt: string;
  /** SHA-256 of the agent's bearer token. The token itself is never stored. */
  tokenHash: string;
  /** ISO time. */
  createdAt: string;

  // Mutable runtime state (not sealed):
  spent: number;
  status: 'active' | 'frozen';
  frozenReason: string | null;
  /** ISO time of the last reinstatement; blocks before it do not count toward the breaker. */
  breakerResetAt: string | null;

  /** HMAC over the sealed fields. */
  seal: string;
  /** Only on the view the rules see: money promised to in-flight payments. Never stored. */
  reserved?: number;
}

/** What sealOf() reads. */
export type SealedMandate = Pick<Mandate, SealedField>;

/** A mandate under construction: everything but the seal, which is computed last. */
export type UnsealedMandate = Omit<Mandate, 'seal'> & { seal?: string };

/** What the dashboard and the agent may see: no credential hash, no seal. */
export type PublicMandate = Omit<Mandate, 'tokenHash' | 'seal'> & { sealValid: boolean };

/**
 * Input to createMandate(). It is built from a policy file plus operator-supplied
 * overrides (a request body), so most fields are unknown until createMandate has
 * validated or coerced them.
 */
export interface MandateInput {
  id?: string;
  user?: unknown;
  policy?: unknown;
  description?: unknown;
  scope?: unknown;
  processor?: unknown;
  currency?: unknown;
  budgetTotal?: unknown;
  perTxCap?: unknown;
  allowedRecipients?: unknown;
  velocityLimit?: { count?: unknown; windowSec?: unknown };
  breaker?: { blocks?: unknown; windowSec?: unknown };
  outOfScope?: unknown;
  expiresAt?: string;
}

// ----------------------------------------------------------------- policy ----

/** A validated policy file (policies/*.json, see policies/policy.schema.json). */
export interface Policy {
  $schema?: string;
  version: 1;
  name: string;
  description: string;
  currency?: string;
  processor?: string;
  budgetTotal: number;
  perTxCap: number;
  allowedRecipients: string[];
  scope?: string[];
  outOfScope?: 'review' | 'block';
  velocityLimit?: VelocityLimit;
  breaker?: Breaker;
  ttlHours?: number;
}

// ---------------------------------------------------------------- request ----

/** Whatever the agent sent. Untrusted until validateRequest() has looked at it. */
export type PaymentRequestRaw = unknown;

/**
 * The safe-to-store echo validateRequest() produces. When validation passed,
 * `amount` is a positive number with at most 2 decimals; when it failed, `amount`
 * may be a truncated string of whatever was sent.
 */
export interface NormalizedRequest {
  amount: number | string;
  currency: string;
  recipient: string;
  purpose: string;
  /** Absent on operator events. */
  idempotencyKey?: string | null;
}

export interface SchemaError { check: string; detail: string }

export interface ValidationResult {
  ok: boolean;
  errors: SchemaError[];
  request: NormalizedRequest;
}

// --------------------------------------------------------------- decision ----

export type Layer = 'schema' | 'rule' | 'anomaly' | 'intent' | 'human' | 'processor';
export type Risk = 'low' | 'med' | 'high';
export type ReasonResult = 'pass' | 'FAIL' | 'ok' | 'FLAG' | Risk | 'error' | 'info';

export interface Reason {
  layer: Layer;
  check: string;
  /** pass | ok | low mean fine. FAIL | FLAG | high | med | error stopped the payment. */
  result: ReasonResult;
  detail: string;
}

export interface DecidedBy { layer: Layer; check: string }

/** Layer 1 result. */
export interface RuleResult { name: string; pass: boolean; detail: string }
/** Layer 2 result. */
export interface AnomalyResult { name: string; flag: boolean; detail: string }

/** Layer 3 result. */
export interface IntentResult {
  risk: Risk;
  reason: string;
  /** 'llm' | 'fallback' | 'signature' | 'skipped' (or whatever a semantic reviewer reports). */
  source: string;
}

/** What a semantic reviewer may answer. Not trusted: assessIntent() normalises `risk`. */
export interface SemanticResult {
  risk: string;
  reason: string;
  source: string;
  category?: string;
}

/**
 * A semantic reviewer: Claude in production, a stub in tests. Returns null when it
 * has no opinion (not configured, over the spend cap, or failed).
 */
export type SemanticFn = (args: { mandate: Mandate; request: NormalizedRequest }) => Promise<SemanticResult | null>;

/** Layers 0-2. */
export interface Screening {
  passed: boolean;
  request: NormalizedRequest;
  reasons: Reason[];
  hardFail: boolean;
  anomalyFlag: boolean;
  malformed: boolean;
}

/** Layers 0-3 folded into a verdict. */
export interface Outcome {
  verdict: 'ALLOW' | 'BLOCK' | 'REVIEW';
  request: NormalizedRequest;
  reasons: Reason[];
  riskScore: number;
  intentSource: string;
  decidedBy: DecidedBy | null;
}

/** 'INFO' is only ever on operator events; 'ERROR' means the processor failed after an ALLOW. */
export type Verdict = 'ALLOW' | 'BLOCK' | 'REVIEW' | 'ERROR' | 'INFO';
export type DecisionKind = 'payment' | 'review_resolution' | 'event';
export type Effect = 'mandate_frozen' | 'mandate_reinstated';

/** A decision being built by the guard, before it is chained into the ledger. */
export interface PendingDecision {
  id: string;
  kind: DecisionKind;
  mandateId: string;
  processor: string;
  request: NormalizedRequest;
  verdict: Verdict;
  /** Every check that ran, in order. */
  reasons: Reason[];
  riskScore: number;
  /** 'llm' | 'fallback' | 'signature' | 'skipped' | 'human' */
  intentSource: string;
  /** The first check that stopped the payment, or null. */
  decidedBy: DecidedBy | null;
  /** ISO time. */
  createdAt: string;
  payment: PaymentResult | null;
  paymentId: string | null;
  /** For a review resolution: the id of the held decision it resolves. */
  resolves: string | null;
  effects: Effect[];
  latencyMs?: number;
}

/** A ledger entry: a decision once it has been chained. */
export interface Decision extends PendingDecision {
  seq: number;
  prevHash: string;
  hash: string;
  /** Only on a response: this is the stored result of an earlier request with the same idempotencyKey. */
  replayed?: boolean;
}

/**
 * What the rules and anomaly checks need from history. Ledger entries qualify, and
 * so do the synthetic entries the guard makes up for in-flight reservations.
 */
export interface HistoryEntry {
  verdict: Verdict;
  createdAt: string;
  request: { amount: number | string };
  id?: string;
  mandateId?: string;
  kind?: DecisionKind;
}

// ------------------------------------------------------------------ guard ----

export interface ErrorBody { error: string }

/** What guardPayment() and resolveReview() resolve with; the server sends it as-is. */
export interface GuardResponse { status: number; body: Decision | ErrorBody }

/** What setFrozen() resolves with. */
export type FreezeResponse = { status: 200; body: Mandate } | { status: 404; body: ErrorBody };

/** Money and a velocity slot held for a payment that is in flight. */
export interface Reservation { amount: number; at: number; key: string | null }

// ------------------------------------------------------------------ audit ----

export type ChainStatus =
  | { ok: true; length: number; brokenAt: null; head: string }
  | { ok: false; length: number; brokenAt: number; brokenId: string | undefined; head: string };

// ---------------------------------------------------------------- metrics ----

export interface Metrics {
  decisions: number;
  byVerdict: Record<'ALLOW' | 'BLOCK' | 'REVIEW' | 'ERROR', number>;
  blockRate: number;
  stoppedByLayer: Record<string, number>;
  stoppedByCheck: Record<string, number>;
  spendByProcessor: Record<string, number>;
  spendTotal: number;
  blockedValue: number;
  reservedInFlight: number;
  reviewsPending: number;
  latencyMs: { p50: number; p95: number; max: number; samples: number };
  mandates: { total: number; frozen: number };
}

// ------------------------------------------------------------------ store ----

export interface StoreState {
  mandates: Record<string, Mandate>;
  decisions: Decision[];
}
