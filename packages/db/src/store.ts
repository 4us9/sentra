// The Store contract the guard service runs on.
//
// Reads and writes are synchronous on purpose. The guard's concurrency model
// (reserve -> execute -> commit) holds the per-mandate lock.
// only for synchronous work, and the hash chain has exactly one writer because
// "read the last entry, append the next" runs to completion without yielding. A
// store that awaited the database inside that section would break both.
//
// So every implementation keeps the hot view in process memory and makes it
// durable behind the scenes. `flush()` resolves once every write made so far is
// durable; the guard awaits it before it answers, outside the lock, so a caller
// never sees a decision that is not on disk / in Postgres.
import type { Decision, Mandate, StoreState } from '@sentra/guard';

/** An operator API key. Only the SHA-256 of the key is ever stored. */
export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyHash: string;
  label: string;
  /** 'admin' may issue/freeze/reinstate/resolve; 'read' may only read the ledger and metrics. */
  scopes: Array<'admin' | 'read'>;
  createdAt: string;
  revokedAt: string | null;
}

export interface StoreHealth {
  kind: 'memory' | 'file' | 'postgres';
  /** False once a durable write has failed; the service then refuses new payments. */
  durable: boolean;
  pendingWrites: number;
  lastError: string | null;
}

export interface Store {
  readonly kind: StoreHealth['kind'];

  saveMandate(m: Mandate): Mandate;
  getMandate(id: string): Mandate | undefined;
  mandateByTokenHash(hash: string): Mandate | null;
  listMandates(): Mandate[];

  /** Append-only. There is no update or delete for decisions. */
  appendDecision(d: Decision): Decision;
  listDecisions(): Decision[];
  decisionsFor(mandateId: string): Decision[];
  findDecision(id: string): Decision | undefined;
  lastDecision(): Decision | undefined;

  saveApiKey(k: ApiKeyRecord): ApiKeyRecord;
  apiKeyByHash(hash: string): ApiKeyRecord | null;
  listApiKeys(): ApiKeyRecord[];

  /** Demo only: wipe everything. */
  reset(): void;
  /** Resolves when every write so far is durable. Rejects if one failed. */
  flush(): Promise<void>;
  health(): StoreHealth;
  close(): Promise<void>;

  /** Test hook: lets a test play an attacker editing storage directly. */
  _tamper(fn: (state: StoreState) => void): void;
}
