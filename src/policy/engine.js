// The decision engine: four layers, strictest wins, and the default is "no".
//
//   0 schema   malformed request                 -> BLOCK (nothing else runs)
//   1 rules    any hard rule fails               -> BLOCK
//   2 anomaly  any behavioural flag              -> BLOCK
//   3 intent   high -> BLOCK, medium -> REVIEW (human decides)
//
// The AI layer can only make a verdict stricter. It is not even consulted once a
// deterministic layer has already blocked, so a prompt injection aimed at the
// reviewer model has nothing to win.
import { validateRequest } from './validate.js';
import { runHardRules } from './rules.js';
import { runAnomaly } from './anomaly.js';
import { assessIntent, llmSemantic } from '../intent.js';

export async function decide(mandate, rawRequest, history, now = Date.now(), semantic = llmSemantic) {
  const v = validateRequest(rawRequest, mandate);
  if (!v.ok) {
    return {
      verdict: 'BLOCK',
      request: v.request,
      reasons: v.errors.map((e) => ({ layer: 'schema', check: e.check, result: 'FAIL', detail: e.detail })),
      riskScore: 1,
      intentSource: 'skipped',
    };
  }
  const request = v.request;
  const hard = runHardRules(mandate, request, history, now);
  const anomalies = runAnomaly(mandate, request, history, now);
  const hardFail = hard.some((r) => !r.pass);
  const anomalyFlag = anomalies.some((a) => a.flag);
  const intent = await assessIntent({ mandate, request, semantic, skipSemantic: hardFail || anomalyFlag });

  const reasons = [
    { layer: 'schema', check: 'well_formed', result: 'pass', detail: 'amount, currency, recipient, purpose are well-formed' },
    ...hard.map((r) => ({ layer: 'rule', check: r.name, result: r.pass ? 'pass' : 'FAIL', detail: r.detail })),
    ...anomalies.map((a) => ({ layer: 'anomaly', check: a.name, result: a.flag ? 'FLAG' : 'ok', detail: a.detail })),
    { layer: 'intent', check: 'intent', result: intent.risk, detail: `${intent.reason} [${intent.source}]` },
  ];

  let verdict;
  if (hardFail || anomalyFlag || intent.risk === 'high') verdict = 'BLOCK';
  else if (intent.risk === 'med') verdict = 'REVIEW';
  else verdict = 'ALLOW';

  const riskScore = Math.min(1, Number((
    (hardFail ? 0.6 : 0) + (anomalyFlag ? 0.3 : 0) + (intent.risk === 'high' ? 0.4 : intent.risk === 'med' ? 0.2 : 0)
  ).toFixed(2)));

  return { verdict, request, reasons, riskScore, intentSource: intent.source };
}

// Used when a human approves a REVIEW: everything deterministic is re-run against the
// state as it is NOW, because budget, velocity or the mandate may have changed since
// the hold. (Approving on stale state is exactly the "cart changed after approval" bug.)
export function recheck(mandate, request, history, now = Date.now()) {
  const hard = runHardRules(mandate, request, history, now);
  const anomalies = runAnomaly(mandate, request, history, now);
  const reasons = [
    ...hard.map((r) => ({ layer: 'rule', check: r.name, result: r.pass ? 'pass' : 'FAIL', detail: r.detail })),
    ...anomalies.map((a) => ({ layer: 'anomaly', check: a.name, result: a.flag ? 'FLAG' : 'ok', detail: a.detail })),
  ];
  return { ok: !hard.some((r) => !r.pass) && !anomalies.some((a) => a.flag), reasons };
}
