// Sentra client SDK. Zero dependencies; works in Node 18+, Bun, Deno and browsers.
//
//   import { Sentra } from 'sentra/sdk';
//   const sentra = new Sentra({ url: process.env.SENTRA_URL, agentToken: process.env.SENTRA_AGENT_TOKEN });
//
//   const decision = await sentra.guard({ amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' });
//   if (decision.verdict === 'ALLOW') { /* paid: decision.paymentId */ }
//
// The agent token identifies the mandate, so there is no mandate argument: an agent
// cannot choose which mandate it is judged against.

export class SentraError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = 'SentraError';
    this.status = status;
  }
}

/** Thrown by guardOrThrow when a payment is not allowed. Carries the full decision. */
export class PaymentRefused extends Error {
  /** @param {import('./index.js').Decision} decision */
  constructor(decision) {
    const why = (decision.reasons || []).find((r) => ['FAIL', 'FLAG', 'high', 'med', 'error'].includes(r.result));
    super(`payment ${decision.verdict}${why ? `: ${why.check}: ${why.detail}` : ''}`);
    this.name = 'PaymentRefused';
    this.decision = decision;
    this.verdict = decision.verdict;
  }
}

export class Sentra {
  /**
   * @param {{ url?: string, agentToken: string, fetch?: typeof fetch, timeoutMs?: number }} options
   */
  constructor({ url = 'http://localhost:3000', agentToken, fetch: fetchImpl, timeoutMs = 60_000 } = /** @type {any} */ ({})) {
    if (!agentToken) throw new SentraError('agentToken is required', 0);
    this.url = String(url).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._token = agentToken;
    this._fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  /**
   * The parsed JSON answer from Sentra; the public methods give it its type.
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async _call(method, path, body) {
    const r = await this._fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new SentraError(j.error || `Sentra returned ${r.status}`, r.status);
    return j;
  }

  /**
   * Ask the firewall to make a payment. Resolves with the decision for every verdict;
   * it only rejects on transport or authentication failure.
   * @param {import('./index.js').PaymentRequest} payment
   * @returns {Promise<import('./index.js').Decision>}
   */
  guard(payment) {
    return this._call('POST', '/guard', payment);
  }

  /**
   * Like guard(), but rejects with PaymentRefused unless the verdict is ALLOW.
   * @param {import('./index.js').PaymentRequest} payment
   */
  async guardOrThrow(payment) {
    const decision = await this.guard(payment);
    if (decision.verdict !== 'ALLOW') throw new PaymentRefused(decision);
    return decision;
  }

  /**
   * What this agent is allowed to do: budget, cap, recipients, status.
   * @returns {Promise<import('./index.js').Mandate>}
   */
  mandate() {
    return this._call('GET', '/guard/mandate');
  }

  /**
   * Wrap an existing payment function so it can only run after Sentra allows it.
   * The wrapped function receives the same payment plus the decision.
   * @template T
   * @param {(payment: import('./index.js').PaymentRequest, decision: import('./index.js').Decision) => Promise<T> | T} fn
   */
  protect(fn) {
    return async (/** @type {import('./index.js').PaymentRequest} */ payment) => fn(payment, await this.guardOrThrow(payment));
  }
}

export default Sentra;
