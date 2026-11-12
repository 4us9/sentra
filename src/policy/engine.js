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
import { assessIntent, llmSemantic } from '../intent.js';

/**
 * The shapes live in src/types.d.ts; these aliases keep `import('./engine.js').Outcome` working.
 * @typedef {import('../types.js').Reason} Reason
 * @typedef {import('../types.js').Screening} Screening
 * @typedef {import('../types.js').Outcome} Outcome
 * @typedef {import('../types.js').DecidedBy} DecidedBy
 * @typedef {import('../types.js').IntentResult} IntentResult
 * @typedef {import('../types.js').Mandate} Mandate
 * @typedef {import('../types.js').HistoryEntry} HistoryEntry
 * @typedef {import('../types.js').PaymentRequestRaw} PaymentRequestRaw
 */

const STOPS = ['FAIL', 'FLAG', 'high', 'med', 'error'];

/**
 * The first reason that stopped the payment: which layer fired, and which check.
 * @param {Reason[]} reasons
 * @returns {DecidedBy | null}
 */
export function decidedBy(reasons) {
  const hit = reasons.find((r) => STOPS.includes(r.result));
  return hit ? { layer: hit.layer, check: hit.check } : null;
}

/**
 * Layers 0-2.
 * @param {Mandate} mandate @param {PaymentRequestRaw} rawRequest @param {HistoryEntry[]} history @param {number} [now]
 * @returns {Screening}
 */
export function screen(mandate, rawRequest, history, now = Date.now()) {
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
      ...hard.map(/** @returns {Reason} */ (r) => ({ layer: 'rule', check: r.name, result: r.pass ? 'pass' : 'FAIL', detail: r.detail })),
      ...anomalies.map(/** @returns {Reason} */ (a) => ({ layer: 'anomaly', check: a.name, result: a.flag ? 'FLAG' : 'ok', detail: a.detail })),
    ],
  };
}

/**
 * Fold the intent result into a screening.
 * @param {Screening} screening @param {IntentResult} intent
 * @returns {Outcome}
 */
export function conclude(screening, intent) {
  if (screening.malformed) {
    return { verdict: 'BLOCK', request: screening.request, reasons: screening.reasons, riskScore: 1, intentSource: 'skipped', decidedBy: decidedBy(screening.reasons) };
  }
  /** @type {Reason[]} */
  const reasons = [
    ...screening.reasons,
    { layer: 'intent', check: 'intent', result: intent.risk, detail: `${intent.reason} [${intent.source}]` },
  ];
  const { hardFail, anomalyFlag } = screening;
  /** @type {Outcome['verdict']} */
  let verdict;
  if (hardFail || anomalyFlag || intent.risk === 'high') verdict = 'BLOCK';
  else if (intent.risk === 'med') verdict = 'REVIEW';
  else verdict = 'ALLOW';
  const riskScore = Math.min(1, Number((
    (hardFail ? 0.6 : 0) + (anomalyFlag ? 0.3 : 0) + (intent.risk === 'high' ? 0.4 : intent.risk === 'med' ? 0.2 : 0)
  ).toFixed(2)));
  return { verdict, request: screening.request, reasons, riskScore, intentSource: intent.source, decidedBy: decidedBy(reasons) };
}

/**
 * Layer 3 for a screening. The model is skipped when layers 0-2 already blocked.
 * @param {Mandate} mandate @param {Screening} screening @param {import('../intent.js').SemanticFn} [semantic]
 * @returns {Promise<IntentResult>}
 */
export function intentFor(mandate, screening, semantic = llmSemantic) {
  if (screening.malformed) return Promise.resolve({ risk: 'low', reason: '', source: 'skipped' });
  return assessIntent({ mandate, request: screening.request, semantic, skipSemantic: !screening.passed });
}

/**
 * All four layers in one call (used by tests and by anything that holds no shared state).
 * @param {Mandate} mandate @param {PaymentRequestRaw} rawRequest @param {HistoryEntry[]} history @param {number} [now] @param {import('../intent.js').SemanticFn} [semantic]
 * @returns {Promise<Outcome>}
 */
export async function decide(mandate, rawRequest, history, now = Date.now(), semantic = llmSemantic) {
  const s = screen(mandate, rawRequest, history, now);
  return conclude(s, await intentFor(mandate, s, semantic));
}

// Used when a human approves a REVIEW: everything deterministic is re-run against the
// state as it is NOW, because budget, velocity or the mandate may have changed since
// the hold. (Approving on stale state is exactly the "cart changed after approval" bug.)
/**
 * @param {Mandate} mandate @param {PaymentRequestRaw} request @param {HistoryEntry[]} history @param {number} [now]
 * @returns {{ ok: boolean, reasons: Reason[] }}
 */
export function recheck(mandate, request, history, now = Date.now()) {
  const s = screen(mandate, request, history, now);
  return { ok: s.passed, reasons: s.reasons.filter((r) => r.layer !== 'schema') };
}
