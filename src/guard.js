// The chokepoint. Every agent payment goes through guardPayment(); nothing else in
// the system can reach PayPal.
//
//   ALLOW  -> executed as a PayPal sandbox order, verified, budget debited
//   BLOCK  -> refused, logged, PayPal never called
//   REVIEW -> held; a human approves or denies it later (resolveReview)
//
// Check-and-commit is atomic per mandate: requests for one mandate run one at a
// time, so two concurrent payments can never both pass the same budget check.
import crypto from 'crypto';
import * as store from './store.js';
import * as paypal from './paypal.js';
import { decide, recheck } from './policy/engine.js';
import { chainEntry, GENESIS, verifyChain } from './audit.js';
import { hashToken } from './mandate.js';

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}
// Synchronous read-last + write: Node runs it to completion, so the hash chain has one writer.
function append(entry) {
  const last = store.lastDecision();
  const sealed = chainEntry({ ...entry, seq: last ? last.seq + 1 : 0 }, last ? last.hash : GENESIS);
  return store.appendDecision(sealed);
}

const newId = (now) => 'dec_' + now.toString(36) + '_' + crypto.randomBytes(5).toString('hex');
const round2 = (n) => Math.round(n * 100) / 100;

export function mandateForToken(token) {
  if (!token) return null;
  const h = Buffer.from(hashToken(token), 'hex');
  return store.listMandates().find((m) => {
    const t = Buffer.from(m.tokenHash, 'hex');
    return t.length === h.length && crypto.timingSafeEqual(t, h);
  }) || null;
}

const paymentHistory = (mandateId) =>
  store.listDecisions().filter((d) => d.mandateId === mandateId && d.kind !== 'event');

async function execute(decision, mandate) {
  try {
    const r = await paypal.executePayment({
      decisionId: decision.id,
      amount: decision.request.amount,
      currency: decision.request.currency,
      recipient: decision.request.recipient,
      purpose: decision.request.purpose,
    });
    decision.paypal = r;
    decision.paypalOrderId = r.orderId;
    mandate.spent = round2(mandate.spent + decision.request.amount);
    store.saveMandate(mandate);
  } catch (e) {
    // Fail closed: no order id, no debit, and the failure is on the record.
    decision.verdict = 'ERROR';
    decision.reasons.push({ layer: 'paypal', check: 'paypal_execute', result: 'error', detail: String(e.message || e).slice(0, 400) });
  }
}

// Circuit breaker: repeated BLOCKs mean the agent is compromised or malfunctioning.
// Freeze the whole mandate until a human reinstates it.
// Only the agent's own blocked attempts count; a human denying a held payment does not.
function tripBreaker(decision, mandate, now) {
  if (decision.verdict !== 'BLOCK' || mandate.status === 'frozen') return;
  const since = Math.max(now - mandate.breaker.windowSec * 1000, mandate.breakerResetAt ? new Date(mandate.breakerResetAt).getTime() : 0);
  const blocks = paymentHistory(mandate.id)
    .filter((d) => d.kind === 'payment' && d.verdict === 'BLOCK' && new Date(d.createdAt).getTime() > since).length + 1;
  if (blocks >= mandate.breaker.blocks) {
    mandate.status = 'frozen';
    mandate.frozenReason = `circuit breaker: ${blocks} blocked payments in ${mandate.breaker.windowSec}s`;
    store.saveMandate(mandate);
    decision.effects = ['mandate_frozen'];
  }
}

export function guardPayment(token, body, { now = Date.now, semantic } = {}) {
  const found = mandateForToken(token);
  if (!found) return Promise.resolve({ status: 401, body: { error: 'missing or invalid agent token' } });

  return withLock(found.id, async () => {
    const t0 = now();
    const mandate = store.getMandate(found.id);           // fresh read inside the lock
    const history = paymentHistory(mandate.id);

    const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : null;
    if (key) {
      const prior = history.find((d) => d.request?.idempotencyKey === key);
      if (prior) return { status: 200, body: { ...prior, replayed: true } };
    }

    const outcome = await decide(mandate, body, history, t0, semantic);
    const decision = {
      id: newId(t0),
      kind: 'payment',
      mandateId: mandate.id,
      request: outcome.request,
      verdict: outcome.verdict,
      reasons: outcome.reasons,
      riskScore: outcome.riskScore,
      intentSource: outcome.intentSource,
      createdAt: new Date(t0).toISOString(),
      paypal: null,
      paypalOrderId: null,
      resolves: null,
      effects: [],
    };

    if (decision.verdict === 'ALLOW') await execute(decision, mandate);
    tripBreaker(decision, mandate, t0);
    decision.latencyMs = now() - t0;
    return { status: 200, body: append(decision) };
  });
}

// Human-in-the-loop: approve or deny a held payment. The original REVIEW entry is
// never edited (the ledger is append-only); the outcome is a new entry that points at it.
export function resolveReview(decisionId, action, { now = Date.now, operator = 'operator' } = {}) {
  const held = store.listDecisions().find((d) => d.id === decisionId);
  if (!held || held.verdict !== 'REVIEW') return Promise.resolve({ status: 404, body: { error: 'no such held payment' } });
  if (!['approve', 'deny'].includes(action)) return Promise.resolve({ status: 400, body: { error: 'action must be approve or deny' } });

  return withLock(held.mandateId, async () => {
    const t0 = now();
    if (store.listDecisions().some((d) => d.resolves === decisionId)) {
      return { status: 409, body: { error: 'already resolved' } };
    }
    const mandate = store.getMandate(held.mandateId);
    const decision = {
      id: newId(t0),
      kind: 'review_resolution',
      mandateId: mandate.id,
      request: held.request,
      verdict: 'BLOCK',
      reasons: [],
      riskScore: held.riskScore,
      intentSource: 'human',
      createdAt: new Date(t0).toISOString(),
      paypal: null,
      paypalOrderId: null,
      resolves: decisionId,
      effects: [],
    };
    if (action === 'deny') {
      decision.reasons.push({ layer: 'human', check: 'human_review', result: 'FAIL', detail: `denied by ${operator}` });
    } else {
      const re = recheck(mandate, held.request, paymentHistory(mandate.id), t0);
      decision.reasons.push({ layer: 'human', check: 'human_review', result: 'pass', detail: `approved by ${operator}` }, ...re.reasons);
      if (re.ok) {
        decision.verdict = 'ALLOW';
        await execute(decision, mandate);
      } else {
        decision.reasons.push({ layer: 'human', check: 'stale_approval', result: 'FAIL', detail: 'approved, but the payment no longer passes the mandate as it stands now' });
      }
    }
    decision.latencyMs = now() - t0;
    return { status: 200, body: append(decision) };
  });
}

// Operator actions (freeze / reinstate) go on the same ledger.
export function setFrozen(mandateId, frozen, { now = Date.now, operator = 'operator' } = {}) {
  return withLock(mandateId, async () => {
    const mandate = store.getMandate(mandateId);
    if (!mandate) return { status: 404, body: { error: 'unknown mandate' } };
    const t0 = now();
    mandate.status = frozen ? 'frozen' : 'active';
    mandate.frozenReason = frozen ? `kill switch: frozen by ${operator}` : null;
    if (!frozen) mandate.breakerResetAt = new Date(t0).toISOString();
    store.saveMandate(mandate);
    append({
      id: newId(t0), kind: 'event', mandateId, verdict: 'INFO',
      request: { amount: 0, currency: mandate.currency, recipient: '', purpose: '' },
      reasons: [{ layer: 'human', check: frozen ? 'kill_switch' : 'reinstate', result: 'info', detail: frozen ? `mandate frozen by ${operator}` : `mandate reinstated by ${operator}` }],
      riskScore: 0, intentSource: 'human', createdAt: new Date(t0).toISOString(),
      paypal: null, paypalOrderId: null, resolves: null, effects: [frozen ? 'mandate_frozen' : 'mandate_reinstated'],
    });
    return { status: 200, body: mandate };
  });
}

export const auditStatus = () => verifyChain(store.listDecisions());
