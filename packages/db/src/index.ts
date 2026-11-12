export type { Store, StoreHealth, ApiKeyRecord } from './store.js';
export { createMemoryStore, readStateFile, emptyState, View, type FullState } from './memory.js';
export { createPostgresStore, readPostgresLedger } from './postgres.js';
import path from 'node:path';
import type { Store } from './store.js';
import { createMemoryStore } from './memory.js';
import { createPostgresStore } from './postgres.js';

/**
 * Picks the store from configuration:
 *   DATABASE_URL set   -> Postgres (Prisma)
 *   otherwise          -> JSON file under dataDir (or pure memory when dataDir is null)
 */
export async function openStore(opts: { databaseUrl?: string; dataDir?: string | null }): Promise<Store> {
  if (opts.databaseUrl) return createPostgresStore({ url: opts.databaseUrl });
  if (opts.dataDir === null) return createMemoryStore();
  return createMemoryStore({ file: path.join(opts.dataDir || 'data', 'db.json') });
}
