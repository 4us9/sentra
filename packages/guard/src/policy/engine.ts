// The decision engine: four layers, strictest wins, and the default is "no".
//
//   0 schema   malformed request                 -> BLOCK (nothing else runs)
//   1 rules    any hard rule fails               -> BLOCK
//   2 anomaly  any behavioural flag              -> BLOCK
//   3 intent   high -> BLOCK, medium -> REVIEW (human decides)
//
// It is split in two so the guard can hold a lock only around the part that reads
// shared state:
//   screen()    layers 0-2. Synchronous, deterministic, reads budget and history.
//   conclude()  folds in the layer-3 result and produces the verdict.
//
// The AI layer can only make a verdict stricter. It is not even consulted once a
// deterministic layer has blocked, so a prompt injection aimed at the reviewer model
// has nothing to win. Nothing in here knows which payment processor is in use.
import { validateRequest } from './validate.js';
import { runHardRules } from './rules.js';
import { runAnomaly } from './anomaly.js';
import { assessIntent } from '../intent.js';
import { guardSemantic } from '../context.js';
import type {
  DecidedBy, HistoryEntry, IntentResult, Mandate, Outcome, PaymentRequestRaw, Reason, Screening, SemanticFn,
} from '../types.js';

export type { Reason, Screening, Outcome, DecidedBy, IntentResult, Mandate, HistoryEntry, PaymentRequestRaw };

const STOPS: string[] = ['FAIL', 'FLAG', 'high', 'med', 'error'];

/** The first reason that stopped the payment: which layer fired, and which check. */
export function decidedBy(reasons: Reason[]): DecidedBy | null {
  const hit = reasons.find((r) => STOPS.includes(r.result));
  return hit ? { layer: hit.layer, check: hit.check } : null;
}

/** Layers 0-2. */
export function screen(mandate: Mandate, rawRequest: PaymentRequestRaw, history: HistoryEntry[], now: number = Date.now()): Screening {
  const v = validateRequest(rawRequest, mandate);
  if (!v.ok) {
    return {
      passed: false, malformed: true, hardFail: true, anomalyFlag: false, request: v.request,
      reasons: v.errors.map((e) => ({ layer: 'schema', check: e.check, result: 'FAIL', detail: e.detail })),
    };
  }
  const hard = runHardRules(mandate, v.request, history, now);
  const anomalies = runAnomaly(mandate, v.request, history, now);
  const hardFail = hard.some((r) => !r.pass);
  const anomalyFlag = anomalies.some((a) => a.flag);
  return {
    passed: !hardFail && !anomalyFlag, malformed: false, hardFail, anomalyFlag, request: v.request,
    reasons: [
      { layer: 'schema', check: 'well_formed', result: 'pass', detail: 'amount, currency, recipient, purpose are well-formed' },
      ...hard.map((r): Reason => ({ layer: 'rule', check: r.name, result: r.pass ? 'pass' : 'FAIL', detail: r.detail })),
      ...anomalies.map((a): Reason => ({ layer: 'anomaly', check: a.name, result: a.flag ? 'FLAG' : 'ok', detail: a.detail })),
    ],
  };
}

/** Fold the intent result into a screening. */
export function conclude(screening: Screening, intent: IntentResult): Outcome {
  if (screening.malformed) {
    return { verdict: 'BLOCK', request: screening.request, reasons: screening.reasons, riskScore: 1, intentSource: 'skipped', decidedBy: decidedBy(screening.reasons) };
  }
  const reasons: Reason[] = [
    ...screening.reasons,
    { layer: 'intent', check: 'intent', result: intent.risk, detail: `${intent.reason} [${intent.source}]` },
  ];
  const { hardFail, anomalyFlag } = screening;
  let verdict: Outcome['verdict'];
  if (hardFail || anomalyFlag || intent.risk === 'high') verdict = 'BLOCK';
  else if (intent.risk === 'med') verdict = 'REVIEW';
  else verdict = 'ALLOW';
  const riskScore = Math.min(1, Number((
    (hardFail ? 0.6 : 0) + (anomalyFlag ? 0.3 : 0) + (intent.risk === 'high' ? 0.4 : intent.risk === 'med' ? 0.2 : 0)
  ).toFixed(2)));
  return { verdict, request: screening.request, reasons, riskScore, intentSource: intent.source, decidedBy: decidedBy(reasons) };
}

/** Layer 3 for a screening. The model is skipped when layers 0-2 already blocked. */
export function intentFor(mandate: Mandate, screening: Screening, semantic: SemanticFn = guardSemantic()): Promise<IntentResult> {
  if (screening.malformed) return Promise.resolve({ risk: 'low', reason: '', source: 'skipped' });
  return assessIntent({ mandate, request: screening.request, semantic, skipSemantic: !screening.passed });
}

/** All four layers in one call (used by tests and by anything that holds no shared state). */
export async function decide(
  mandate: Mandate, rawRequest: PaymentRequestRaw, history: HistoryEntry[], now: number = Date.now(), semantic: SemanticFn = guardSemantic(),
): Promise<Outcome> {
  const s = screen(mandate, rawRequest, history, now);
  return conclude(s, await intentFor(mandate, s, semantic));
}

// Used when a human approves a REVIEW: everything deterministic is re-run against the
// state as it is NOW, because budget, velocity or the mandate may have changed since
// the hold. (Approving on stale state is exactly the "cart changed after approval" bug.)
export function recheck(mandate: Mandate, request: PaymentRequestRaw, history: HistoryEntry[], now: number = Date.now()): { ok: boolean; reasons: Reason[] } {
  const s = screen(mandate, request, history, now);
  return { ok: s.passed, reasons: s.reasons.filter((r) => r.layer !== 'schema') };
}
