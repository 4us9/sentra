// Postgres store (Prisma).
//
// Model: Postgres is the durable, append-only record; the process holds the hot
// view (see store.ts for why reads and writes are synchronous). On open:
//
//   1. take a session-level advisory lock on a dedicated connection. Exactly one
//      Sentra instance may write a ledger: a second one refuses to start instead
//      of forking the hash chain.
//   2. load mandates, the ledger (ordered by seq) and API keys into the view.
//
// Every mutation is then queued and written in order. `flush()` resolves when the
// queue has drained; the guard awaits it before answering. The first failed write
// marks the store non-durable and stops all further writes (a gap would break the
// chain in Postgres); the service then refuses new payments and /health says why.
import { PrismaClient, Prisma } from '@prisma/client';
import type { Decision, Mandate } from '@sentra/guard';
import type { ApiKeyRecord, Store } from './store.js';
import { View, emptyState, storeOver, type FullState, type Sink } from './memory.js';

const LOCK_KEY = 0x53_45_4e_54;   // "SENT"
const DEFAULT_TENANT = 'default';

const date = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

function mandateRow(m: Mandate) {
  return {
    id: m.id,
    tenantId: DEFAULT_TENANT,
    user: m.user,
    policy: m.policy,
    description: m.description,
    scope: m.scope,
    processor: m.processor,
    currency: m.currency,
    budgetTotal: m.budgetTotal,
    perTxCap: m.perTxCap,
    allowedRecipients: m.allowedRecipients,
    velocityCount: m.velocityLimit.count,
    velocityWindowSec: m.velocityLimit.windowSec,
    breakerBlocks: m.breaker.blocks,
    breakerWindowSec: m.breaker.windowSec,
    outOfScope: m.outOfScope,
    expiresAt: new Date(m.expiresAt),
    tokenHash: m.tokenHash,
    seal: m.seal,
    spent: m.spent,
    status: m.status,
    frozenReason: m.frozenReason,
    breakerResetAt: date(m.breakerResetAt),
    createdAt: new Date(m.createdAt),
    doc: JSON.stringify(m),
  };
}

function decisionRow(d: Decision) {
  return {
    id: d.id,
    seq: d.seq,
    mandateId: d.mandateId,
    kind: d.kind,
    processor: d.processor,
    verdict: d.verdict,
    request: json(d.request),
    reasons: json(d.reasons),
    riskScore: d.riskScore,
    intentSource: d.intentSource,
    decidedBy: d.decidedBy ? json(d.decidedBy) : Prisma.JsonNull,
    payment: d.payment ? json(d.payment) : Prisma.JsonNull,
    paymentId: d.paymentId,
    resolves: d.resolves,
    effects: d.effects,
    latencyMs: d.latencyMs ?? null,
    prevHash: d.prevHash,
    hash: d.hash,
    createdAt: new Date(d.createdAt),
    doc: JSON.stringify(d),
  };
}

function apiKeyRow(k: ApiKeyRecord) {
  return {
    id: k.id, tenantId: k.tenantId || DEFAULT_TENANT, keyHash: k.keyHash, label: k.label,
    scopes: k.scopes, createdAt: new Date(k.createdAt), revokedAt: date(k.revokedAt),
  };
}

/** One connection, so the session-level advisory lock lives as long as the client. */
function singleConnection(url: string): string {
  const u = new URL(url);
  u.searchParams.set('connection_limit', '1');
  return u.toString();
}

/** A verifier is incapable of writing even if its implementation regresses. */
function readOnlyConnection(url: string): string {
  const u = new URL(url);
  u.searchParams.set('options', '-c default_transaction_read_only=on');
  return u.toString();
}

export async function createPostgresStore(opts: { url: string }): Promise<Store> {
  const db = new PrismaClient({ datasources: { db: { url: singleConnection(opts.url) } } });
  await db.$connect();

  const [{ locked }] = await db.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
  if (!locked) {
    await db.$disconnect();
    throw new Error('another Sentra instance holds the ledger writer lock on this database');
  }

  await db.tenant.upsert({ where: { id: DEFAULT_TENANT }, update: {}, create: { id: DEFAULT_TENANT, name: 'Default tenant' } });

  const [mandates, decisions, keys] = await Promise.all([
    db.mandate.findMany({ select: { id: true, doc: true } }),
    db.decision.findMany({ orderBy: { seq: 'asc' }, select: { doc: true } }),
    db.apiKey.findMany(),
  ]);
  const initial: FullState = emptyState();
  for (const m of mandates) initial.mandates[m.id] = JSON.parse(m.doc) as Mandate;
  initial.decisions = decisions.map((d) => JSON.parse(d.doc) as Decision);
  for (const k of keys) {
    initial.apiKeys[k.id] = {
      id: k.id, tenantId: k.tenantId, keyHash: k.keyHash, label: k.label,
      scopes: k.scopes as ApiKeyRecord['scopes'], createdAt: k.createdAt.toISOString(),
      revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    };
  }
  const view = new View(initial);

  // ---- ordered write queue ----
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let lastError: string | null = null;
  const enqueue = (write: () => Promise<unknown>): void => {
    pending++;
    tail = tail.then(async () => {
      try {
        if (!lastError) await write();
      } catch (e) {
        lastError = String((e as Error).message || e).slice(0, 300);
      } finally {
        pending--;
      }
    });
  };

  const sink: Sink = {
    mandate: (m) => enqueue(() => {
      const row = mandateRow(m);
      return db.mandate.upsert({ where: { id: m.id }, create: row, update: row });
    }),
    // Insert only. A decision is never updated or deleted (invariant 7).
    decision: (d) => enqueue(() => db.decision.create({ data: decisionRow(d) })),
    apiKey: (k) => enqueue(() => {
      const row = apiKeyRow(k);
      return db.apiKey.upsert({ where: { id: k.id }, create: row, update: row });
    }),
    // Demo reset only (the operator's "Reset demo"). Wipes the ledger by design.
    reset: () => enqueue(() => db.$transaction([db.decision.deleteMany(), db.mandate.deleteMany(), db.apiKey.deleteMany()])),
  };

  return storeOver(view, sink, {
    kind: 'postgres',
    flush: async () => {
      await tail;
      if (lastError) throw new Error(`ledger write failed: ${lastError}`);
    },
    health: () => ({ kind: 'postgres', durable: !lastError, pendingWrites: pending, lastError }),
    close: async () => {
      await tail;
      await db.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
      await db.$disconnect();
    },
  });
}

/**
 * Read the ledger without opening the writer store or taking its advisory lock.
 * This is deliberately separate from `createPostgresStore`: integrity checks may
 * run against a live service and must never contend with payment processing.
 */
export async function readPostgresLedger(opts: { url: string }): Promise<{ decisions: Decision[]; mandates: Mandate[] }> {
  const db = new PrismaClient({ datasources: { db: { url: readOnlyConnection(opts.url) } } });
  try {
    await db.$connect();
    const [mandates, decisions] = await Promise.all([
      db.mandate.findMany({ orderBy: { id: 'asc' }, select: { doc: true } }),
      db.decision.findMany({ orderBy: { seq: 'asc' }, select: { doc: true } }),
    ]);
    return {
      mandates: mandates.map((m) => JSON.parse(m.doc) as Mandate),
      decisions: decisions.map((d) => JSON.parse(d.doc) as Decision),
    };
  } finally {
    await db.$disconnect();
  }
}
