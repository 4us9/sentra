// Wire types for the Sentra guard service. Everything inside a Decision that came from
// an agent (request.*, reasons[].detail, ...) is attacker-controlled: render as text only.

export type Verdict = 'ALLOW' | 'BLOCK' | 'REVIEW' | 'ERROR' | 'INFO';
export type Layer = 'schema' | 'rule' | 'anomaly' | 'intent' | 'human' | 'processor';
export type DecisionKind = 'payment' | 'review_resolution' | 'event';

export interface Reason { layer: Layer | string; check: string; result: string; detail: string }
export interface DecidedBy { layer: Layer | string; check: string }

export interface NormalizedRequest {
  amount: number | string;
  currency: string;
  recipient: string;
  purpose: string;
  idempotencyKey?: string | null;
}

export interface PaymentResult {
  processor?: string;
  mode?: string;
  id?: string;
  status?: string;
  [k: string]: unknown;
}

export interface Decision {
  id: string;
  seq: number;
  kind: DecisionKind;
  mandateId: string;
  processor: string;
  request: NormalizedRequest;
  verdict: Verdict;
  reasons: Reason[];
  riskScore: number;
  intentSource: string;
  decidedBy: DecidedBy | null;
  createdAt: string;
  payment: PaymentResult | null;
  paymentId: string | null;
  resolves: string | null;
  effects: string[];
  latencyMs?: number;
  prevHash: string;
  hash: string;
  replayed?: boolean;
}

export interface Mandate {
  id: string;
  user: string;
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
  sealValid: boolean;
  reserved?: number;
}

export interface ProcessorInfo { name: string; label: string; mode: string; default?: boolean }

export interface ServiceConfig {
  paypal?: string;
  processors: ProcessorInfo[];
  intent: 'llm' | 'fallback' | string;
  intentModel: string | null;
  operatorAuth: boolean;
  policies: string[];
  defaultPolicy: string | null;
}

export interface Policy {
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
  velocityLimit?: { count: number; windowSec: number };
  breaker?: { blocks: number; windowSec: number };
  ttlHours?: number;
}

export type ChainStatus =
  | { ok: true; length: number; brokenAt: null; head: string }
  | { ok: false; length: number; brokenAt: number; brokenId?: string; head: string };

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

export interface ServiceState {
  mandates: Mandate[];
  decisions: Decision[];
  audit: ChainStatus;
  metrics: Metrics;
  config: ServiceConfig;
}

export interface Scenario {
  id: string;
  category: 'legit' | 'attack' | string;
  expect: string;
  title: string;
  blurb: string;
  concurrent?: boolean;
  steps: { amount: number; recipient: string; purpose: string }[];
}

export interface LedgerResponse { total: number; offset: number; limit: number; entries: Decision[]; audit: ChainStatus }
export interface PaymentInput { amount: number | string; recipient: string; purpose: string; currency?: string; idempotencyKey?: string }
export interface Health extends ServiceConfig { ok: boolean }
