# @sentra/db

Persistence for the Sentra guard service, behind one `Store` contract (`src/store.ts`).

| Store | When | Durability |
|---|---|---|
| `createMemoryStore()` | tests, throwaway demos | none |
| `createMemoryStore({ file })` | default (`data/db.json`) | atomic write-through (tmp + rename) |
| `createPostgresStore({ url })` | `DATABASE_URL` is set | ordered write queue to Postgres; `flush()` awaited before every answer |

Reads and writes are synchronous against an in-process view, so the guard's
per-mandate lock never spans an await on the database, and the hash chain keeps a
single writer. Postgres adds a session-level **advisory lock**: a second Sentra
instance pointed at the same database refuses to start rather than fork the chain.
Multi-instance (row locks, shared reservations) is on the roadmap.

Decisions are insert-only. Each row stores the exact chained entry as JSON text
(`doc`) next to queryable columns: jsonb can drop a float digit, and one digit
breaks a hash.

```bash
DATABASE_URL=postgresql://... pnpm --filter @sentra/db migrate        # apply prisma/migrations
DATABASE_URL=postgresql://... pnpm --filter @sentra/db import-json data/db.json   # bring a 0.3 ledger over, chain verified before and after
SENTRA_TEST_DATABASE_URL=postgresql://.../throwaway pnpm --filter @sentra/db test # runs the Postgres contract too (wipes that DB)
```
