import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMandate, type Decision, type MandateInput, type PaymentProcessor, type SemanticFn,
} from '@sentra/guard';
import { createMemoryStore, type Store } from '@sentra/db';
import type { FastifyInstance } from 'fastify';
import { createGuard, type Guard } from '../src/guard.js';
import { buildApp, loadPolicies } from '../src/app.js';
import { getProcessor } from '../src/processors/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_DIR = path.resolve(here, '..');
export const POLICY_DIR = path.resolve(SERVICE_DIR, '..', '..', 'policies');
export const PUBLIC_DIR = path.resolve(SERVICE_DIR, 'public');

export const now = Date.parse('2026-11-12T12:00:00Z');
export const low: SemanticFn = async () => ({ risk: 'low', reason: 'stub', source: 'stub' });
export const med: SemanticFn = async () => ({ risk: 'med', reason: 'stub', source: 'stub' });
export const high: SemanticFn = async () => ({ risk: 'high', reason: 'stub', source: 'stub' });
export const none: SemanticFn = async () => null;            // "no model configured"

export const ok = { amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' };
export const wide = { velocityLimit: { count: 1000, windowSec: 60 }, breaker: { blocks: 1000, windowSec: 60 } };
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A decision as an HTTP caller sees it (adds the replay marker and the error body). */
export type D = Decision & { replayed?: boolean; error?: string };

export function fakeProcessor({ delay = 20, fail = false }: { delay?: number; fail?: boolean } = {}) {
  const calls: Array<Parameters<PaymentProcessor['createPayment']>[0]> = [];
  const p = {
    name: 'fake',
    label: 'Fake',
    mode: () => 'simulated' as const,
    calls,
    active: 0,
    peak: 0,
    async createPayment(req: Parameters<PaymentProcessor['createPayment']>[0]) {
      calls.push(req);
      p.active++; p.peak = Math.max(p.peak, p.active);
      await sleep(delay);
      p.active--;
      if (fail) throw new Error('processor down (Bearer abcdefghijklmnop sk_test_abcdefghijkl)');
      return { processor: 'fake', id: 'FAKE-' + calls.length, status: 'OK', mode: 'simulated' as const, verified: true };
    },
  };
  return p;
}

export interface Env {
  store: Store;
  guard: Guard;
  issue: (partial?: MandateInput) => { id: string; token: string };
  pay: (token: string, body: unknown, semantic?: SemanticFn) => Promise<D>;
}

/** A fresh store + guard. Nothing is shared between tests. */
export function createEnv(store: Store = createMemoryStore(), log: (line: string) => void = () => {}): Env {
  const guard = createGuard({ store, getProcessor, log });
  const issue = (partial: MandateInput = {}) => {
    const { mandate, agentToken } = createMandate(partial);
    store.saveMandate(mandate);
    return { id: mandate.id, token: agentToken };
  };
  const pay = (token: string, body: unknown, semantic: SemanticFn = low) =>
    guard.guardPayment(token, body, { semantic }).then((r) => r.body as D);
  return { store, guard, issue, pay };
}

/** A fresh Fastify app over a fresh (or given) store, serving the real policies. */
export async function createTestApp(opts: { store?: Store; corsOrigins?: string[]; publicDir?: string | null } = {}): Promise<{ app: FastifyInstance; store: Store; guard: Guard }> {
  const store = opts.store ?? createMemoryStore();
  const guard = createGuard({ store, getProcessor, log: () => {} });
  const app = await buildApp({
    store, guard,
    policies: loadPolicies(POLICY_DIR),
    defaultPolicy: 'grocery-run',
    publicDir: opts.publicDir === undefined ? PUBLIC_DIR : opts.publicDir,
    corsOrigins: opts.corsOrigins ?? [],
  });
  return { app, store, guard };
}
