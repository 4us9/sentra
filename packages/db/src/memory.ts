// The in-process view every store is built on, plus the two simple stores:
//   createMemoryStore()            nothing durable (tests, ephemeral demos)
//   createMemoryStore({ file })    atomic write-through to a JSON file (tmp + rename)
import fs from 'node:fs';
import path from 'node:path';
import type { Decision, Mandate, StoreState } from '@sentra/guard';
import type { ApiKeyRecord, Store, StoreHealth } from './store.js';

export interface FullState extends StoreState { apiKeys: Record<string, ApiKeyRecord> }

const clone = <T>(x: T): T => (x === undefined ? x : structuredClone(x));
export const emptyState = (): FullState => ({ mandates: {}, decisions: [], apiKeys: {} });

/** What a concrete store does when the view changes. */
export interface Sink {
  mandate(m: Mandate): void;
  decision(d: Decision): void;
  apiKey(k: ApiKeyRecord): void;
  reset(): void;
}

/**
 * Indexed in-memory state. The indexes keep the hot path (one /guard call) from
 * scanning every mandate and every decision ever made.
 */
export class View {
  state: FullState;
  private byToken = new Map<string, string>();
  private byMandate = new Map<string, Decision[]>();
  private byKey = new Map<string, string>();

  constructor(initial: FullState = emptyState()) {
    this.state = initial;
    this.reindex();
  }

  reindex(): void {
    this.byToken = new Map(Object.values(this.state.mandates).map((m) => [m.tokenHash, m.id]));
    this.byKey = new Map(Object.values(this.state.apiKeys).map((k) => [k.keyHash, k.id]));
    this.byMandate = new Map();
    for (const d of this.state.decisions) this.index(d);
  }

  private index(d: Decision): void {
    const list = this.byMandate.get(d.mandateId);
    if (list) list.push(d); else this.byMandate.set(d.mandateId, [d]);
  }

  saveMandate(m: Mandate): Mandate {
    const before = this.state.mandates[m.id];
    // A replaced mandate's old token must stop working.
    if (before && before.tokenHash !== m.tokenHash) this.byToken.delete(before.tokenHash);
    this.state.mandates[m.id] = clone(m);
    this.byToken.set(m.tokenHash, m.id);
    return m;
  }
  getMandate(id: string): Mandate | undefined { return clone(this.state.mandates[id]); }
  mandateByTokenHash(hash: string): Mandate | null {
    const id = this.byToken.get(hash);
    return id ? clone(this.state.mandates[id]) ?? null : null;
  }
  listMandates(): Mandate[] { return clone(Object.values(this.state.mandates)); }

  appendDecision(d: Decision): Decision {
    const copy = clone(d);
    this.state.decisions.push(copy);
    this.index(copy);
    return d;
  }
  listDecisions(): Decision[] { return clone(this.state.decisions); }
  decisionsFor(mandateId: string): Decision[] { return clone(this.byMandate.get(mandateId) || []); }
  findDecision(id: string): Decision | undefined { return clone(this.state.decisions.find((d) => d.id === id)); }
  lastDecision(): Decision | undefined { return clone(this.state.decisions[this.state.decisions.length - 1]); }

  saveApiKey(k: ApiKeyRecord): ApiKeyRecord {
    const before = this.state.apiKeys[k.id];
    if (before && before.keyHash !== k.keyHash) this.byKey.delete(before.keyHash);
    this.state.apiKeys[k.id] = clone(k);
    this.byKey.set(k.keyHash, k.id);
    return k;
  }
  apiKeyByHash(hash: string): ApiKeyRecord | null {
    const id = this.byKey.get(hash);
    return id ? clone(this.state.apiKeys[id]) ?? null : null;
  }
  listApiKeys(): ApiKeyRecord[] { return clone(Object.values(this.state.apiKeys)); }

  reset(): void { this.state = emptyState(); this.reindex(); }
}

/**
 * Builds a Store from a View and a Sink: every mutation updates the view
 * synchronously, then tells the sink, which makes it durable.
 */
export function storeOver(
  view: View,
  sink: Sink,
  extra: { kind: StoreHealth['kind']; flush: () => Promise<void>; health: () => StoreHealth; close: () => Promise<void> },
): Store {
  return {
    kind: extra.kind,
    saveMandate: (m) => { view.saveMandate(m); sink.mandate(clone(m)); return m; },
    getMandate: (id) => view.getMandate(id),
    mandateByTokenHash: (h) => view.mandateByTokenHash(h),
    listMandates: () => view.listMandates(),
    appendDecision: (d) => { view.appendDecision(d); sink.decision(clone(d)); return d; },
    listDecisions: () => view.listDecisions(),
    decisionsFor: (id) => view.decisionsFor(id),
    findDecision: (id) => view.findDecision(id),
    lastDecision: () => view.lastDecision(),
    saveApiKey: (k) => { view.saveApiKey(k); sink.apiKey(clone(k)); return k; },
    apiKeyByHash: (h) => view.apiKeyByHash(h),
    listApiKeys: () => view.listApiKeys(),
    reset: () => { view.reset(); sink.reset(); },
    flush: extra.flush,
    health: extra.health,
    close: extra.close,
    // Deliberately bypasses the sink: tampering edits the live view only, which is
    // what an attacker with memory or file access would do.
    _tamper: (fn) => { fn(view.state); view.reindex(); },
  };
}

/** Loads a JSON ledger written by this store (or by Sentra 0.3's data/db.json). */
export function readStateFile(file: string): FullState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { mandates: s.mandates || {}, decisions: s.decisions || [], apiKeys: s.apiKeys || {} };
  } catch {
    return emptyState();
  }
}

export function createMemoryStore(opts: { file?: string } = {}): Store {
  const file = opts.file ? path.resolve(opts.file) : null;
  const view = new View(file ? readStateFile(file) : emptyState());
  let lastError: string | null = null;

  const persist = (): void => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(view.state, null, 2));
      fs.renameSync(tmp, file);   // atomic: a crash never leaves a half-written ledger
    } catch (e) {
      lastError = String((e as Error).message || e);
    }
  };
  const sink: Sink = { mandate: persist, decision: persist, apiKey: persist, reset: persist };

  return storeOver(view, sink, {
    kind: file ? 'file' : 'memory',
    flush: async () => { if (lastError) throw new Error(`ledger write failed: ${lastError}`); },
    health: () => ({ kind: file ? 'file' : 'memory', durable: !lastError, pendingWrites: 0, lastError }),
    close: async () => {},
  });
}
