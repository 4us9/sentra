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
// The lock is only held for synchronous work (the Store contract is synchronous for
// exactly this reason), so a slow model or processor never stalls other payments,
// and two concurrent payments can never both be approved against one budget.
// Before answering, the guard waits for the store to make the entry durable.
import crypto from 'node:crypto';
import {
  screen, conclude, intentFor, recheck, decidedBy, mandateIntegrity, mandateActive, validateRequest,
  chainEntry, GENESIS, verifyChain, hashToken, formatDecisionLog, scrubSecrets,
  type Mandate, type Decision, type PendingDecision, type DecisionKind, type HistoryEntry, type Reservation,
  type GuardResponse, type FreezeResponse, type Outcome, type Reason, type Effect, type PaymentResult,
  type PaymentProcessor, type SemanticFn, type ChainStatus,
} from '@sentra/guard';
import type { Store } from '@sentra/db';

export interface GuardDeps {
  store: Store;
  getProcessor: (name: string) => PaymentProcessor;
  /** Where one JSON line per decision goes. Defaults to stdout unless SENTRA_LOG=off. */
  log?: (line: string) => void;
}
interface CallOpts { now?: () => number; semantic?: SemanticFn; processor?: PaymentProcessor; operator?: string }

const KEY_REUSED: GuardResponse = { status: 409, body: { error: 'idempotencyKey was already used for a different payment' } };
const NOT_DURABLE: GuardResponse = { status: 503, body: { error: 'ledger is not durable; payments are paused until an operator fixes storage' } };
const fingerprint = (r: { amount?: unknown; currency?: unknown; recipient?: unknown; purpose?: unknown } | null | undefined) =>
  JSON.stringify([r?.amount, r?.currency, r?.recipient, r?.purpose]);
const newId = (now: number) => 'dec_' + now.toString(36) + '_' + crypto.randomBytes(5).toString('hex');
const round2 = (n: number) => Math.round(n * 100) / 100;
const pick = (o: Outcome) => ({ verdict: o.verdict, reasons: o.reasons, riskScore: o.riskScore, intentSource: o.intentSource, decidedBy: o.decidedBy });
const defaultLog = (line: string) => { if (process.env.SENTRA_LOG !== 'off') process.stdout.write(line + '\n'); };

export type Guard = ReturnType<typeof createGuard>;

export function createGuard({ store, getProcessor, log = defaultLog }: GuardDeps) {
  // ---- per-mandate lock ----
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(key, run.catch(() => {}));
    return run;
  }

  // ---- in-flight reservations: mandateId -> Map(decisionId -> reservation) ----
  const inflight = new Map<string, Map<string, Reservation>>();
  const pendingByKey = new Map<string, { fingerprint: string; promise: Promise<GuardResponse> }>();
  const reservations = (mandateId: string) => inflight.get(mandateId) || new Map<string, Reservation>();
  function reserve(mandateId: string, decisionId: string, amount: number, at: number, key: string | null) {
    if (!inflight.has(mandateId)) inflight.set(mandateId, new Map());
    inflight.get(mandateId)!.set(decisionId, { amount, at, key });
  }
  function release(mandateId: string, decisionId: string) {
    const m = inflight.get(mandateId);
    if (m) { m.delete(decisionId); if (m.size === 0) inflight.delete(mandateId); }
  }
  /** Drop all in-flight bookkeeping. Used with store.reset() by the demo reset. */
  function resetGuardState() { inflight.clear(); pendingByKey.clear(); }
  const reservedTotal = (mandateId: string) => round2([...reservations(mandateId).values()].reduce((a, r) => a + r.amount, 0));

  // Synchronous read-last + write: runs to completion, so the hash chain has one writer.
  function append(entry: PendingDecision): Decision {
    const last = store.lastDecision();
    const sealed = chainEntry({ ...entry, seq: last ? last.seq + 1 : 0 }, last ? last.hash : GENESIS) as Decision;
    store.appendDecision(sealed);
    log(formatDecisionLog(sealed));
    return sealed;
  }

  // The response leaves only once the ledger entry (and the debit) are durable.
  async function durable<T>(r: T): Promise<T> {
    try { await store.flush(); }
    catch (e) { console.error('[guard] ledger flush failed:', String((e as Error).message || e).slice(0, 200)); }
    return r;
  }

  function mandateForToken(token: string | null | undefined): Mandate | null {
    if (!token) return null;
    // Looked up by the SHA-256 of the token: the token itself is never stored or compared.
    return store.mandateByTokenHash(hashToken(token));
  }

  const ledgerHistory = (mandateId: string) => store.decisionsFor(mandateId).filter((d) => d.kind !== 'event');

  // What the rules see: the ledger plus every in-flight reservation counted as if it
  // had already been allowed (for budget, velocity and drain detection alike).
  function liveView(mandateId: string, except?: string): { mandate: Mandate; view: Mandate; history: HistoryEntry[] } {
    const mandate = store.getMandate(mandateId) as Mandate;
    const held = [...reservations(mandateId).entries()].filter(([id]) => id !== except);
    const reserved = round2(held.reduce((a, [, r]) => a + r.amount, 0));
    const history: HistoryEntry[] = [
      ...ledgerHistory(mandateId),
      ...held.map(([id, r]): HistoryEntry => ({ id, mandateId, kind: 'payment', verdict: 'ALLOW', request: { amount: r.amount }, createdAt: new Date(r.at).toISOString() })),
    ];
    return { mandate, view: { ...mandate, reserved }, history };
  }

  function baseDecision(id: string, kind: DecisionKind, mandate: Mandate, t0: number): PendingDecision {
    return {
      id, kind, mandateId: mandate.id, processor: mandate.processor,
      // Filled in by every caller before the decision is appended or executed.
      request: null as unknown as PendingDecision['request'],
      verdict: 'BLOCK', reasons: [], riskScore: 0, intentSource: 'skipped', decidedBy: null,
      createdAt: new Date(t0).toISOString(),
      payment: null, paymentId: null, resolves: null, effects: [],
    };
  }

  // Circuit breaker: repeated BLOCKs mean the agent is compromised or malfunctioning.
  // Freeze the mandate until a human reinstates it. Only the agent's own blocked
  // attempts count; a human denying a held payment does not.
  function tripBreaker(decision: PendingDecision, now: number) {
    const mandate = store.getMandate(decision.mandateId);
    if (!mandate) return;
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
  // Only reached after the request passed screening, so request.amount is a validated number.
  async function executeAndCommit(decision: PendingDecision, { processor, now }: { processor: PaymentProcessor; now: () => number }): Promise<Decision> {
    let result: PaymentResult | null = null;
    let failure: unknown = null;
    try {
      result = await processor.createPayment({
        amount: decision.request.amount as number,
        currency: decision.request.currency,
        recipient: decision.request.recipient,
        purpose: decision.request.purpose,
        idempotencyKey: decision.id,
      });
    } catch (e) { failure = e; }

    return withLock(decision.mandateId, async () => {
      release(decision.mandateId, decision.id);
      const live = store.getMandate(decision.mandateId);
      if (result && !live) {
        // The mandate was removed (demo reset) while this payment was at the processor.
        // The payment happened, so it goes on the record even though nothing can be debited.
        decision.payment = result;
        decision.paymentId = result.id;
        decision.verdict = 'ERROR';
        decision.reasons.push({ layer: 'processor', check: 'mandate_missing', result: 'error', detail: `payment ${result.id} was executed, but its mandate no longer exists, so it could not be debited` });
        decision.decidedBy = decidedBy(decision.reasons);
      } else if (result) {
        const mandate = live as Mandate;
        mandate.spent = round2(mandate.spent + (decision.request.amount as number));
        store.saveMandate(mandate);
        decision.payment = result;
        decision.paymentId = result.id;
      } else {
        // Fail closed: no payment id, no debit, and the failure is on the record.
        decision.verdict = 'ERROR';
        decision.reasons.push({ layer: 'processor', check: `${processor.name}_execute`, result: 'error', detail: scrubSecrets(String((failure as { message?: unknown } | null)?.message || failure)).slice(0, 400) });
        decision.decidedBy = decidedBy(decision.reasons);
      }
      decision.latencyMs = now() - new Date(decision.createdAt).getTime();
      return append(decision);
    });
  }

  type First =
    | { done: GuardResponse; join?: undefined }
    | { join: Promise<GuardResponse>; done?: undefined }
    | { decision: PendingDecision; screening: ReturnType<typeof screen>; mandate: Mandate; done?: undefined; join?: undefined };

  async function guardPaymentInner(token: string, body: unknown, { now = Date.now, semantic, processor }: CallOpts): Promise<GuardResponse> {
    const found = mandateForToken(token);
    if (!found) return { status: 401, body: { error: 'missing or invalid agent token' } };
    if (!store.health().durable) return NOT_DURABLE;
    const mandateId = found.id;
    const raw = body as { idempotencyKey?: unknown } | null;
    const key = typeof raw?.idempotencyKey === 'string' ? raw.idempotencyKey : null;
    const pendingKey = key ? `${mandateId}:${key}` : null;

    // ---- step 1 (locked): idempotency, screen, reserve ----
    const first: First = await withLock(mandateId, async (): Promise<First> => {
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
        const pending = pendingByKey.get(pendingKey!);
        if (pending) return pending.fingerprint === mine ? { join: pending.promise } : { done: KEY_REUSED };
      }
      const { mandate, view, history } = liveView(mandateId);
      const decision = baseDecision(newId(t0), 'payment', mandate, t0);
      const screening = screen(view, body, history, t0);
      decision.request = screening.request;
      if (!screening.passed) {
        // Layers 0-2 blocked: the model is not consulted (intentFor skips it).
        Object.assign(decision, pick(conclude(screening, await intentFor(mandate, screening, semantic))));
        tripBreaker(decision, t0);
        decision.latencyMs = now() - t0;
        return { done: { status: 200, body: append(decision) } };
      }
      reserve(mandateId, decision.id, screening.request.amount as number, t0, key);
      return { decision, screening, mandate };
    });
    if (first.done) return first.done;
    if (first.join) return first.join.then((r) => (r.status === 200 ? { status: 200, body: { ...(r.body as Decision), replayed: true } } : r));

    const { decision, screening, mandate } = first;
    const rest = (async (): Promise<GuardResponse> => {
      try {
        // ---- step 2 (no lock): intent ----
        const outcome = conclude(screening, await intentFor(mandate, screening, semantic));
        Object.assign(decision, pick(outcome));

        // ---- step 3 (locked): stop here unless ALLOW and the mandate is still usable ----
        const stop = await withLock(mandateId, async (): Promise<GuardResponse | null> => {
          const t = now();
          if (decision.verdict === 'ALLOW') {
            const fresh = store.getMandate(mandateId);
            const gate = fresh
              ? [mandateIntegrity(fresh), mandateActive(fresh)].filter((r) => !r.pass)
              : [{ name: 'mandate_exists', pass: false, detail: 'mandate no longer exists' }];
            if (gate.length === 0) return null;
            decision.verdict = 'BLOCK';
            decision.reasons.push(...gate.map((r): Reason => ({ layer: 'rule', check: r.name, result: 'FAIL', detail: `${r.detail} (changed while this payment was in flight)` })));
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
        promise: rest.catch((): GuardResponse => ({ status: 500, body: { error: 'the original request failed' } })),
      });
    }
    return rest;
  }

  /** token: the agent's mandate-scoped bearer token. body: the untrusted payment request. */
  async function guardPayment(token: string, body: unknown, opts: CallOpts = {}): Promise<GuardResponse> {
    return durable(await guardPaymentInner(token, body, opts));
  }

  // Human-in-the-loop: approve or deny a held payment. The original REVIEW entry is
  // never edited (append-only); the outcome is a new entry that points at it.
  async function resolveReview(decisionId: string, action: string, { now = Date.now, operator = 'operator', processor }: CallOpts = {}): Promise<GuardResponse> {
    const held = store.findDecision(decisionId);
    if (!held || held.verdict !== 'REVIEW') return { status: 404, body: { error: 'no such held payment' } };
    if (!['approve', 'deny'].includes(action)) return { status: 400, body: { error: 'action must be approve or deny' } };
    if (!store.health().durable) return NOT_DURABLE;

    type R = { done: GuardResponse } | { done?: undefined; decision: PendingDecision; mandate: Mandate };
    const first: R = await withLock(held.mandateId, async (): Promise<R> => {
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
        // Re-run everything deterministic against the state as it is NOW: approving on
        // stale state is exactly the "cart changed after approval" bug.
        const re = recheck(view, held.request, history, t0);
        decision.reasons.push({ layer: 'human', check: 'human_review', result: 'pass', detail: `approved by ${operator}` }, ...re.reasons);
        if (re.ok) {
          decision.verdict = 'ALLOW';
          reserve(mandate.id, decision.id, held.request.amount as number, t0, `review:${decisionId}`);
          return { decision, mandate };
        }
        decision.reasons.push({ layer: 'human', check: 'stale_approval', result: 'FAIL', detail: 'approved, but the payment no longer passes the mandate as it stands now' });
      }
      decision.decidedBy = decidedBy(decision.reasons);
      decision.latencyMs = now() - t0;
      return { done: { status: 200, body: append(decision) } };
    });
    if (first.done) return durable(first.done);
    try {
      return durable({ status: 200, body: await executeAndCommit(first.decision, { processor: processor || getProcessor(first.mandate.processor), now }) });
    } catch (e) {
      release(held.mandateId, first.decision.id);
      throw e;
    }
  }

  // Operator actions go on the same ledger as payments, so "who allowed this agent to
  // spend, and when was it frozen or reinstated" is answered by one tamper-evident record.
  function appendEvent(mandate: Mandate, t0: number, check: string, detail: string, effects: Effect[] = []): Decision {
    const event = baseDecision(newId(t0), 'event', mandate, t0);
    Object.assign(event, {
      verdict: 'INFO', intentSource: 'human',
      request: { amount: 0, currency: mandate.currency, recipient: '', purpose: '' },
      reasons: [{ layer: 'human', check, result: 'info', detail }],
      effects,
    });
    return append(event);
  }

  /** Record that a mandate was issued. Called once, right after it is first saved. */
  async function recordIssued(mandate: Mandate, { now = Date.now, operator = 'operator' }: CallOpts = {}): Promise<Decision> {
    return durable(await withLock(mandate.id, async () => appendEvent(
      mandate, now(), 'mandate_issued',
      `issued by ${operator}${mandate.policy ? ` from policy "${mandate.policy}"` : ''}: ${mandate.currency} ${mandate.budgetTotal} budget, ${mandate.perTxCap} per payment, ${mandate.allowedRecipients.length} recipient(s), rail ${mandate.processor}`,
    )));
  }

  async function setFrozen(mandateId: string, frozen: boolean, { now = Date.now, operator = 'operator' }: CallOpts = {}): Promise<FreezeResponse> {
    return durable(await withLock(mandateId, async (): Promise<FreezeResponse> => {
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
    }));
  }

  const auditStatus = (): ChainStatus => verifyChain(store.listDecisions());

  return { guardPayment, resolveReview, recordIssued, setFrozen, resetGuardState, reservedTotal, mandateForToken, auditStatus };
}
