// The chokepoint. Every agent payment goes through guardPayment(); nothing else in
// the system can reach a payment processor.
//
//   ALLOW  -> executed on the mandate's processor, verified, budget debited
//   BLOCK  -> refused, logged, processor never called
//   REVIEW -> held; a human approves or denies it later (resolveReview)
//   ERROR  -> passed the firewall but the processor failed; nothing debited
//
// Concurrency model: reserve -> execute -> commit / release.
//
//   1. under the mandate lock   screen (schema, rules, anomaly) against
//                               spent + everything currently reserved; if it
//                               passes, RESERVE the amount and a velocity slot
//   2. no lock                  intent check (may call a model)
//   3. under the lock           re-check the mandate is still usable (kill switch,
//                               seal), otherwise release
//   4. no lock                  processor call
//   5. under the lock           COMMIT (debit) or RELEASE, append to the ledger
//
// The lock is only ever held for synchronous work, so a slow model or processor
// never stalls other payments, and two concurrent payments can never both be
// approved against the same budget: the second one sees the first one's reservation.
import crypto from 'crypto';
import * as store from './store.js';
import { screen, conclude, intentFor, recheck, decidedBy } from './policy/engine.js';
import { mandateIntegrity, mandateActive } from './policy/rules.js';
import { validateRequest } from './policy/validate.js';
import { chainEntry, GENESIS, verifyChain } from './audit.js';
import { hashToken } from './mandate.js';
import { getProcessor } from './processors/index.js';
import { logDecision, scrubSecrets } from './log.js';

/**
 * @typedef {import('./types.js').Mandate} Mandate
 * @typedef {import('./types.js').Decision} Decision
 * @typedef {import('./types.js').PendingDecision} PendingDecision
 * @typedef {import('./types.js').DecisionKind} DecisionKind
 * @typedef {import('./types.js').HistoryEntry} HistoryEntry
 * @typedef {import('./types.js').Reservation} Reservation
 * @typedef {import('./types.js').GuardResponse} GuardResponse
 * @typedef {import('./types.js').FreezeResponse} FreezeResponse
 * @typedef {import('./types.js').Outcome} Outcome
 * @typedef {import('./types.js').Reason} Reason
 * @typedef {import('./types.js').Effect} Effect
 * @typedef {import('./types.js').PaymentResult} PaymentResult
 * @typedef {import('./types.js').PaymentProcessor} PaymentProcessor
 */

// ---- per-mandate lock ----
/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();
/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

// ---- in-flight reservations: mandateId -> Map(decisionId -> { amount, at, key }) ----
/** @type {Map<string, Map<string, Reservation>>} */
const inflight = new Map();
/** @type {Map<string, { fingerprint: string, promise: Promise<GuardResponse> }>} */
const pendingByKey = new Map();          // `${mandateId}:${idempotencyKey}` -> { fingerprint, promise }
/** @type {GuardResponse} */
const KEY_REUSED = { status: 409, body: { error: 'idempotencyKey was already used for a different payment' } };
/** @param {{ amount?: unknown, currency?: unknown, recipient?: unknown, purpose?: unknown } | null | undefined} r */
const fingerprint = (r) => JSON.stringify([r?.amount, r?.currency, r?.recipient, r?.purpose]);
/** @param {string} mandateId @returns {Map<string, Reservation>} */
const reservations = (mandateId) => inflight.get(mandateId) || new Map();
/** @param {string} mandateId @param {string} decisionId @param {number} amount @param {number} at @param {string | null} key */
function reserve(mandateId, decisionId, amount, at, key) {
  if (!inflight.has(mandateId)) inflight.set(mandateId, new Map());
  /** @type {Map<string, Reservation>} */ (inflight.get(mandateId)).set(decisionId, { amount, at, key });
}
/** @param {string} mandateId @param {string} decisionId */
function release(mandateId, decisionId) {
  const m = inflight.get(mandateId);
  if (m) { m.delete(decisionId); if (m.size === 0) inflight.delete(mandateId); }
}
/** @param {string} mandateId */
export const reservedTotal = (mandateId) =>
  round2([...reservations(mandateId).values()].reduce((a, r) => a + r.amount, 0));

// Synchronous read-last + write: Node runs it to completion, so the hash chain has one writer.
/** @param {PendingDecision} entry @returns {Decision} */
function append(entry) {
  const last = store.lastDecision();
  const sealed = chainEntry({ ...entry, seq: last ? last.seq + 1 : 0 }, last ? last.hash : GENESIS);
  store.appendDecision(sealed);
  logDecision(sealed);
  return sealed;
}

/** @param {number} now */
const newId = (now) => 'dec_' + now.toString(36) + '_' + crypto.randomBytes(5).toString('hex');
/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/** @param {string | null | undefined} token @returns {Mandate | null} */
export function mandateForToken(token) {
  if (!token) return null;
  // Looked up by the SHA-256 of the token: the token itself is never stored or
  // compared, and a hash lookup leaks nothing useful through timing.
  return store.mandateByTokenHash(hashToken(token));
}

/** @param {string} mandateId */
const ledgerHistory = (mandateId) => store.decisionsFor(mandateId).filter((d) => d.kind !== 'event');

// What the rules see: the ledger, plus every in-flight reservation counted as if it
// had already been allowed (for budget, velocity and drain detection alike).
/**
 * @param {string} mandateId
 * @param {string} [except]
 * @returns {{ mandate: Mandate, view: Mandate, history: HistoryEntry[] }}
 */
function liveView(mandateId, except) {
  const mandate = /** @type {Mandate} */ (store.getMandate(mandateId));
  const held = [...reservations(mandateId).entries()].filter(([id]) => id !== except);
  const reserved = round2(held.reduce((a, [, r]) => a + r.amount, 0));
  const history = [
    ...ledgerHistory(mandateId),
    ...held.map(/** @returns {HistoryEntry} */ ([id, r]) => ({ id, mandateId, kind: 'payment', verdict: 'ALLOW', request: { amount: r.amount }, createdAt: new Date(r.at).toISOString() })),
  ];
  return { mandate, view: { ...mandate, reserved }, history };
}

/**
 * @param {string} id @param {DecisionKind} kind @param {Mandate} mandate @param {number} t0
 * @returns {PendingDecision}
 */
function baseDecision(id, kind, mandate, t0) {
  return {
    id, kind, mandateId: mandate.id, processor: mandate.processor,
    // Type note: `request` is null only until the caller fills it in, which every
    // caller does before the decision is appended or executed.
    request: /** @type {PendingDecision['request']} */ (/** @type {unknown} */ (null)), verdict: 'BLOCK', reasons: [], riskScore: 0, intentSource: 'skipped', decidedBy: null,
    createdAt: new Date(t0).toISOString(),
    payment: null, paymentId: null,
    resolves: null, effects: [],
  };
}

// Circuit breaker: repeated BLOCKs mean the agent is compromised or malfunctioning.
// Freeze the whole mandate until a human reinstates it.
// Only the agent's own blocked attempts count; a human denying a held payment does not.
/** @param {PendingDecision} decision @param {number} now */
function tripBreaker(decision, now) {
  const mandate = /** @type {Mandate} */ (store.getMandate(decision.mandateId));
  if (decision.kind !== 'payment' || decision.verdict !== 'BLOCK' || mandate.status === 'frozen') return;
  const since = Math.max(now - mandate.breaker.windowSec * 1000, mandate.breakerResetAt ? new Date(mandate.breakerResetAt).getTime() : 0);
  const blocks = ledgerHistory(mandate.id)
    .filter((d) => d.kind === 'payment' && d.verdict === 'BLOCK' && new Date(d.createdAt).getTime() > since).length + 1;
  if (blocks >= mandate.breaker.blocks) {
    mandate.status = 'frozen';
    mandate.frozenReason = `circuit breaker: ${blocks} blocked payments in ${mandate.breaker.windowSec}s`;
    store.saveMandate(mandate);
    decision.effects = ['mandate_frozen'];
  }
}

// Steps 4 and 5: call the processor with no lock held, then commit or release under it.
/**
 * Type note: a decision only gets here after its request passed screening, so
 * `request.amount` is a validated number (the casts below say so to the checker).
 * @param {PendingDecision} decision
 * @param {{ processor: PaymentProcessor, now: () => number }} opts
 * @returns {Promise<Decision>}
 */
async function executeAndCommit(decision, { processor, now }) {
  /** @type {PaymentResult | null} */
  let result = null;
  /** @type {unknown} */
  let failure = null;
  try {
    result = await processor.createPayment({
      amount: /** @type {number} */ (decision.request.amount),
      currency: decision.request.currency,
      recipient: decision.request.recipient,
      purpose: decision.request.purpose,
      idempotencyKey: decision.id,
    });
  } catch (e) { failure = e; }

  return withLock(decision.mandateId, async () => {
    release(decision.mandateId, decision.id);
    if (result) {
      const mandate = /** @type {Mandate} */ (store.getMandate(decision.mandateId));
      mandate.spent = round2(mandate.spent + /** @type {number} */ (decision.request.amount));
      store.saveMandate(mandate);
      decision.payment = result;
      decision.paymentId = result.id;
    } else {
      // Fail closed: no payment id, no debit, and the failure is on the record.
      decision.verdict = 'ERROR';
      decision.reasons.push({ layer: 'processor', check: `${processor.name}_execute`, result: 'error', detail: scrubSecrets(String(/** @type {{ message?: unknown } | null} */ (failure)?.message || failure)).slice(0, 400) });
      decision.decidedBy = decidedBy(decision.reasons);
    }
    decision.latencyMs = now() - new Date(decision.createdAt).getTime();
    return append(decision);
  });
}

/**
 * @param {string} token   the agent's mandate-scoped bearer token
 * @param {unknown} body   the untrusted payment request
 * @param {{ now?: () => number, semantic?: import('./intent.js').SemanticFn, processor?: import('./processors/index.js').PaymentProcessor }} [opts]
 * @returns {Promise<GuardResponse>}
 */
export async function guardPayment(token, body, { now = Date.now, semantic, processor } = {}) {
  const found = mandateForToken(token);
  if (!found) return { status: 401, body: { error: 'missing or invalid agent token' } };
  const mandateId = found.id;
  const raw = /** @type {any} */ (body);
  const key = typeof raw?.idempotencyKey === 'string' ? raw.idempotencyKey : null;
  const pendingKey = key ? `${mandateId}:${key}` : null;

  // ---- step 1 (locked): idempotency, screen, reserve ----
  const first = await withLock(mandateId, async () => {
    const t0 = now();
    if (key) {
      // A key names one payment. Reusing it for a different amount, recipient or
      // purpose is refused rather than silently answered with the old decision.
      const mine = fingerprint(validateRequest(body, found).request);
      const prior = store.decisionsFor(mandateId).find((d) => d.request?.idempotencyKey === key);
      if (prior) {
        if (fingerprint(prior.request) !== mine) return { done: KEY_REUSED };
        return { done: { status: 200, body: { ...prior, replayed: true } } };
      }
      const pending = pendingByKey.get(/** @type {string} */ (pendingKey));
      if (pending) return pending.fingerprint === mine ? { join: pending.promise } : { done: KEY_REUSED };
    }
    const { mandate, view, history } = liveView(mandateId);
    const decision = baseDecision(newId(t0), 'payment', mandate, t0);
    const screening = screen(view, body, history, t0);
    decision.request = screening.request;
    if (!screening.passed) {
      Object.assign(decision, pick(conclude(screening, await intentFor(mandate, screening, semantic))));
      tripBreaker(decision, t0);
      decision.latencyMs = now() - t0;
      return { done: { status: 200, body: append(decision) } };
    }
    reserve(mandateId, decision.id, /** @type {number} */ (screening.request.amount), t0, key);
    return { decision, screening, mandate };
  });
  if (first.done) return first.done;
  if (first.join) return first.join.then((r) => ({ status: r.status, body: { ...r.body, replayed: true } }));

  const { decision, screening, mandate } = first;
  const rest = (async () => {
    try {
      // ---- step 2 (no lock): intent ----
      const outcome = conclude(screening, await intentFor(mandate, screening, semantic));
      Object.assign(decision, pick(outcome));

      // ---- step 3 (locked): stop here unless ALLOW and the mandate is still usable ----
      const stop = await withLock(mandateId, async () => {
        const t = now();
        if (decision.verdict === 'ALLOW') {
          const fresh = /** @type {Mandate} */ (store.getMandate(mandateId));
          const gate = [mandateIntegrity(fresh), mandateActive(fresh)].filter((r) => !r.pass);
          if (gate.length === 0) return null;
          decision.verdict = 'BLOCK';
          decision.reasons.push(...gate.map(/** @returns {Reason} */ (r) => ({ layer: 'rule', check: r.name, result: 'FAIL', detail: `${r.detail} (changed while this payment was in flight)` })));
          decision.decidedBy = decidedBy(decision.reasons);
        }
        release(mandateId, decision.id);
        tripBreaker(decision, t);
        decision.latencyMs = t - new Date(decision.createdAt).getTime();
        return { status: 200, body: append(decision) };
      });
      if (stop) return stop;

      // ---- steps 4-5: execute, then commit or release ----
      return { status: 200, body: await executeAndCommit(decision, { processor: processor || getProcessor(mandate.processor), now }) };
    } catch (e) {
      release(mandateId, decision.id);
      throw e;
    } finally {
      if (pendingKey) pendingByKey.delete(pendingKey);
    }
  })();
  if (pendingKey) {
    pendingByKey.set(pendingKey, {
      fingerprint: fingerprint(decision.request),
      promise: rest.catch(() => ({ status: 500, body: { error: 'the original request failed' } })),
    });
  }
  return rest;
}

/** @param {Outcome} o */
const pick = (o) => ({ verdict: o.verdict, reasons: o.reasons, riskScore: o.riskScore, intentSource: o.intentSource, decidedBy: o.decidedBy });

// Human-in-the-loop: approve or deny a held payment. The original REVIEW entry is
// never edited (the ledger is append-only); the outcome is a new entry that points at it.
/**
 * @param {string} decisionId
 * @param {string} action  'approve' | 'deny'
 * @param {{ now?: () => number, operator?: string, processor?: import('./processors/index.js').PaymentProcessor }} [opts]
 * @returns {Promise<GuardResponse>}
 */
export async function resolveReview(decisionId, action, { now = Date.now, operator = 'operator', processor } = {}) {
  const held = store.findDecision(decisionId);
  if (!held || held.verdict !== 'REVIEW') return { status: 404, body: { error: 'no such held payment' } };
  if (!['approve', 'deny'].includes(action)) return { status: 400, body: { error: 'action must be approve or deny' } };

  const first = await withLock(held.mandateId, async () => {
    const t0 = now();
    const taken = store.decisionsFor(held.mandateId).some((d) => d.resolves === decisionId)
      || [...reservations(held.mandateId).values()].some((r) => r.key === `review:${decisionId}`);
    if (taken) return { done: { status: 409, body: { error: 'already resolved' } } };

    const { mandate, view, history } = liveView(held.mandateId);
    const decision = baseDecision(newId(t0), 'review_resolution', mandate, t0);
    Object.assign(decision, { request: held.request, riskScore: held.riskScore, intentSource: 'human', resolves: decisionId });

    if (action === 'deny') {
      decision.reasons.push({ layer: 'human', check: 'human_review', result: 'FAIL', detail: `denied by ${operator}` });
    } else {
      const re = recheck(view, held.request, history, t0);
      decision.reasons.push({ layer: 'human', check: 'human_review', result: 'pass', detail: `approved by ${operator}` }, ...re.reasons);
      if (re.ok) {
        decision.verdict = 'ALLOW';
        reserve(mandate.id, decision.id, /** @type {number} */ (held.request.amount), t0, `review:${decisionId}`);
        return { decision, mandate };
      }
      decision.reasons.push({ layer: 'human', check: 'stale_approval', result: 'FAIL', detail: 'approved, but the payment no longer passes the mandate as it stands now' });
    }
    decision.decidedBy = decidedBy(decision.reasons);
    decision.latencyMs = now() - t0;
    return { done: { status: 200, body: append(decision) } };
  });
  if (first.done) return first.done;
  try {
    return { status: 200, body: await executeAndCommit(first.decision, { processor: processor || getProcessor(first.mandate.processor), now }) };
  } catch (e) {
    release(held.mandateId, first.decision.id);
    throw e;
  }
}

// Operator actions go on the same ledger as payments, so "who allowed this agent to
// spend, and when was it frozen or reinstated" is answered by one tamper-evident record.
/**
 * @param {Mandate} mandate @param {number} t0 @param {string} check @param {string} detail @param {Effect[]} [effects]
 * @returns {Decision}
 */
function appendEvent(mandate, t0, check, detail, effects = []) {
  const event = baseDecision(newId(t0), 'event', mandate, t0);
  Object.assign(event, {
    verdict: 'INFO', intentSource: 'human',
    request: { amount: 0, currency: mandate.currency, recipient: '', purpose: '' },
    reasons: [{ layer: 'human', check, result: 'info', detail }],
    effects,
  });
  return append(event);
}

/**
 * Record that a mandate was issued. Called once, right after it is first saved.
 * @param {Mandate} mandate
 * @param {{ now?: () => number, operator?: string }} [opts]
 * @returns {Promise<Decision>}
 */
export function recordIssued(mandate, { now = Date.now, operator = 'operator' } = {}) {
  return withLock(mandate.id, async () => appendEvent(
    mandate, now(), 'mandate_issued',
    `issued by ${operator}${mandate.policy ? ` from policy "${mandate.policy}"` : ''}: ${mandate.currency} ${mandate.budgetTotal} budget, ${mandate.perTxCap} per payment, ${mandate.allowedRecipients.length} recipient(s), rail ${mandate.processor}`,
  ));
}

/**
 * @param {string} mandateId
 * @param {boolean} frozen
 * @param {{ now?: () => number, operator?: string }} [opts]
 * @returns {Promise<FreezeResponse>}
 */
export function setFrozen(mandateId, frozen, { now = Date.now, operator = 'operator' } = {}) {
  return withLock(mandateId, async () => {
    const mandate = store.getMandate(mandateId);
    if (!mandate) return { status: 404, body: { error: 'unknown mandate' } };
    const t0 = now();
    mandate.status = frozen ? 'frozen' : 'active';
    mandate.frozenReason = frozen ? `kill switch: frozen by ${operator}` : null;
    if (!frozen) mandate.breakerResetAt = new Date(t0).toISOString();
    store.saveMandate(mandate);
    appendEvent(mandate, t0, frozen ? 'kill_switch' : 'reinstate',
      frozen ? `mandate frozen by ${operator}` : `mandate reinstated by ${operator}`,
      [frozen ? 'mandate_frozen' : 'mandate_reinstated']);
    return { status: 200, body: mandate };
  });
}

export const auditStatus = () => verifyChain(store.listDecisions());
