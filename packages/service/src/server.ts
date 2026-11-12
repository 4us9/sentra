// Sentra guard service entry point.
//
//   DATABASE_URL        Postgres (Prisma); otherwise a JSON file under SENTRA_DATA_DIR (default data/)
//   SENTRA_SECRET       mandate-sealing key; otherwise generated once into the data dir
//   SENTRA_WEB_ORIGIN   comma-separated origins allowed to call the API from a browser
//   PORT                default 3000
import './env.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureGuard } from '@sentra/guard';
import { openStore, type Store } from '@sentra/db';
import { repoRoot } from './env.js';
import { createGuard } from './guard.js';
import { buildApp, loadPolicies } from './app.js';
import { getProcessor, processorNames, processorStatus, defaultProcessorName } from './processors/index.js';
import { llmConfigured, intentModel, llmSemantic } from './llm.js';

const root = repoRoot();
export const dataDir = () => path.resolve(root, process.env.SENTRA_DATA_DIR || 'data');

/** Env wins; otherwise generated once and kept next to the data so seals survive a restart. */
export function loadSecret(dir: string): string {
  if (process.env.SENTRA_SECRET) return process.env.SENTRA_SECRET;
  const file = path.join(dir, 'secret.key');
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s) return s; } catch { /* first boot */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export async function start(): Promise<{ store: Store; close: () => Promise<void> }> {
  const secret = loadSecret(dataDir());
  configureGuard({ secret: () => secret, processors: processorNames(), defaultProcessor: defaultProcessorName(), semantic: llmSemantic });
  const store = await openStore({ databaseUrl: process.env.DATABASE_URL, dataDir: dataDir() });
  const guard = createGuard({ store, getProcessor });
  const app = await buildApp({
    store, guard,
    policies: loadPolicies(path.resolve(root, process.env.SENTRA_POLICY_DIR || 'policies')),
    defaultPolicy: process.env.SENTRA_DEFAULT_POLICY || 'grocery-run',
    publicDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
    corsOrigins: (process.env.SENTRA_WEB_ORIGIN || 'http://localhost:3100').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: Boolean(process.env.SENTRA_TRUST_PROXY),
  });
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
  console.log(`Sentra running on http://localhost:${port}`);
  for (const p of processorStatus()) {
    console.log(`  ${p.label}: ${p.mode === 'simulated' ? 'SIMULATED (no credentials; payment ids start with SIM-)' : p.mode.toUpperCase()}${p.default ? '  [default]' : ''}`);
  }
  console.log(`  Intent: ${llmConfigured() ? `Claude (${intentModel()}) + signatures` : 'signatures + vocabulary fallback (no ANTHROPIC_API_KEY)'}`);
  console.log(`  Storage: ${store.kind}`);
  const close = async () => { await app.close(); await store.close(); };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { close().finally(() => process.exit(0)); });
  return { store, close };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) start().catch((e) => { console.error('Sentra failed to start:', String(e?.message || e)); process.exit(1); });
