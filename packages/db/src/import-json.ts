#!/usr/bin/env node
// Import a Sentra 0.3 ledger (data/db.json) into Postgres, preserving every id,
// seq and hash so the chain still verifies. Refuses to run against a non-empty
// database, and verifies the chain before and after.
//
//   DATABASE_URL=postgres://... node dist/import-json.js path/to/db.json
import { verifyChain } from '@sentra/guard';
import { readStateFile } from './memory.js';
import { createPostgresStore } from './postgres.js';

const file = process.argv[2];
const url = process.env.DATABASE_URL;
if (!file || !url) { console.error('usage: DATABASE_URL=... import-json <db.json>'); process.exit(2); }

const src = readStateFile(file);
const before = verifyChain(src.decisions);
if (!before.ok) { console.error(`source ledger is broken at entry #${before.brokenAt}; refusing to import`); process.exit(1); }

const store = await createPostgresStore({ url });
if (store.listDecisions().length || store.listMandates().length) {
  console.error('target database is not empty; refusing to import'); await store.close(); process.exit(1);
}
for (const m of Object.values(src.mandates)) store.saveMandate(m);
for (const d of src.decisions) store.appendDecision(d);
await store.flush();
const after = verifyChain(store.listDecisions());
console.log(`imported ${Object.keys(src.mandates).length} mandates, ${src.decisions.length} decisions; chain ${after.ok ? 'verifies' : 'BROKEN'}`);
await store.close();
process.exit(after.ok ? 0 : 1);
