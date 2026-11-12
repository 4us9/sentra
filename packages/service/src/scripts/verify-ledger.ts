#!/usr/bin/env node
// pnpm verify-ledger [path/to/db.json]
//
// Offline integrity check, independent of the running server:
//   1. recomputes the audit hash chain over every decision
//   2. re-verifies the HMAC seal on every mandate
// Exits 0 when everything verifies, 1 on tamper, 2 if the file cannot be read.
// Suitable for cron or CI against a copy of the ledger.
import '../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { verifyChain, configureGuard, sealValid, type Decision, type Mandate } from '@sentra/guard';
import { readPostgresLedger } from '@sentra/db';
import { repoRoot } from '../env.js';
import { loadSecret } from '../server.js';

const arg = process.argv[2];
const file = path.resolve(arg || path.join(repoRoot(), process.env.SENTRA_DATA_DIR || 'data', 'db.json'));
// Seals are keyed by the secret that sits next to the ledger (or SENTRA_SECRET).
const secret = loadSecret(path.dirname(file));
configureGuard({ secret: () => secret });

let decisions: Decision[];
let mandates: Mandate[];
let source: string;
try {
  if (!arg && process.env.DATABASE_URL) {
    // This uses a short-lived, read-only Prisma client. It does not take the
    // service's advisory writer lock, so it is safe while the service is live.
    ({ decisions, mandates } = await readPostgresLedger({ url: process.env.DATABASE_URL }));
    source = 'Postgres';
  } else {
    const db = JSON.parse(fs.readFileSync(file, 'utf8')) as { decisions?: Decision[]; mandates?: Record<string, Mandate> };
    decisions = db.decisions || [];
    mandates = Object.values(db.mandates || {});
    source = file;
  }
} catch (e) {
  const target = !arg && process.env.DATABASE_URL ? 'Postgres' : file;
  console.error(`verify-ledger: cannot read ${target}: ${(e as Error).message}`);
  process.exit(2);
}
const chain = verifyChain(decisions);
let bad = 0;

if (chain.ok) {
  console.log(`ledger   OK       ${chain.length} entries, head ${chain.head.slice(0, 16)}...`);
} else {
  bad++;
  console.log(`ledger   TAMPERED entry #${chain.brokenAt} (${chain.brokenId}) does not match the chain; ${chain.length - chain.brokenAt} entries from there on cannot be trusted`);
}

for (const m of mandates) {
  if (sealValid(m)) console.log(`mandate  OK       ${m.id}`);
  else { bad++; console.log(`mandate  TAMPERED ${m.id}: policy fields do not match the seal`); }
}

console.log(bad ? `\nFAILED: ${bad} integrity problem(s) in ${source}` : `\nOK: ${source} verifies`);
process.exit(bad ? 1 : 0);
