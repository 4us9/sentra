# TypeScript monorepo migration: where it stands, what's next

Branch: `ts-monorepo`. `main` is untouched: it is the submission and what Render
deploys (https://sentra-x8zr.onrender.com). Do not merge before the hackathon is
submitted.

Run pnpm as `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@9.15.0 …` (there is no
global pnpm).

## Done (committed on the branch)
| Package | State |
|---|---|
| root | pnpm workspaces, Turborepo, `tsconfig.base.json` |
| `@sentra/guard` | pure engine in TS. No I/O. Secret, rails and reviewer injected with `configureGuard()`. 171 tests incl. the 93-attack corpus |
| `@sentra/db` | `Store` contract, file store, Postgres store (Prisma), advisory-lock single writer, migration `0001_init`, 0.3 JSON importer. 7 tests (Postgres ones need `SENTRA_TEST_DATABASE_URL`) |
| `@sentra/service` | Fastify API, same routes as 0.3, plus operator API keys (`/api/keys`), CORS, storage health. Demo verified on the file store and on Postgres: identical verdicts on both rails, second writer refused, chain intact after restart. **No tests yet** |
| `@sentra/sdk`, `@sentra/mcp` | TS ports, 19 tests |

## In progress when the session stopped (uncommitted; check before trusting)
- `packages/service/test/**`: a sub-agent was porting `test/sentra.test.mjs`,
  `test/http.test.mjs`, `test/scenarios.test.mjs` and the corpus through
  `guardPayment` to Vitest. If it is partial, finish it (brief below).
- `apps/web/**`: a sub-agent was building the Next.js 15 + Tailwind + shadcn app
  (landing, docs, pricing, dashboard pages, TanStack ledger, optional Clerk).
  Check it with `pnpm --filter @sentra/web build` and
  `grep -rn dangerouslySetInnerHTML apps/web --include=*.tsx` (must be empty).
- `pnpm-lock.yaml` is not committed yet (web deps were still being added).

## Next, in order
1. **Service tests.** Port the remaining guard/HTTP/scenario tests to
   `packages/service/test` with `createGuard` + `createMemoryStore()` + `app.inject()`.
   Cover the new parts too: API keys (root-only minting, read scope gets 403,
   revoked key gets 401, `sat_` never accepted as an operator credential), 503 when
   the store is not durable, and CORS. Never weaken an assertion; fix product code instead.
2. **Web app.** Finish, build, and check it against the service:
   `SENTRA_WEB_ORIGIN=http://localhost:3100 PORT=4000 pnpm start`, then
   `NEXT_PUBLIC_SENTRA_API=http://localhost:4000 pnpm --filter @sentra/web start`.
   Check landing, dashboard, Attack Lab and ledger at 1440px and 390px with no
   console errors. Commit `apps/web` and `pnpm-lock.yaml`.
3. **Delete the old tree** once 1 and 2 are green: `src/`, `sdk/`, `mcp/`,
   `agent/`, `scripts/`, `test/*.mjs`, `test/corpus/`, root `tsconfig.json`,
   `package-lock.json`. Move `examples/` to `@sentra/sdk` imports.
4. **`verify-ledger` for Postgres.** It reads the file store only. Add a
   read-only Prisma path; it must not take the writer lock.
5. **CI** (`.github/workflows/ci.yml`): pnpm + `turbo run build typecheck test` on
   Node 20/22/24. Add a Postgres service container with `SENTRA_TEST_DATABASE_URL`
   so the Postgres contract tests run. Keep the hygiene job, and add
   `packages/guard/src/log.ts` and `**/test/**` to its grep exclusions.
6. **Deploy configs.**
   - `render.yaml` on the branch: build with
     `corepack enable && pnpm install --frozen-lockfile && pnpm build`, start with
     `pnpm start`.
   - Optional Render Postgres, with `DATABASE_URL` and `pnpm --filter @sentra/db migrate` as a pre-deploy step.
   - `apps/web` on Vercel with `NEXT_PUBLIC_SENTRA_API` and `SENTRA_WEB_ORIGIN` set on the service.
   - A `packages/service/Dockerfile` (Fly/Render).
7. **Docs.**
   - README: monorepo layout, pnpm commands, the file map.
   - CLAUDE.md section 2 and the invariant 3/4 paths, which now live in `packages/service/src/guard.ts` and `packages/guard`.
   - CHANGELOG 0.4.0, STATUS.md.
8. **Release.** Open a PR from `ts-monorepo` to `main` after judging, or after
   submitting if you are confident. Tag `v0.4.0`.

## Design notes for whoever continues
- The Store is **synchronous on purpose**. The guard's lock must never span an
  await on the DB or the processor (invariant 3), and the hash chain needs a single
  writer. Postgres is written through an ordered queue, and `guardPayment` awaits
  `store.flush()` before answering. Do not "fix" this into async reads under the lock.
- Decision and mandate rows keep the exact JSON in a **text** `doc` column. A jsonb
  round trip dropped a float digit (`1.3333333333333333` became `1.333333333333333`)
  and broke the hash. Load from `doc`, never rebuild from the columns.
- Multi-instance (row locks, shared reservations and rate limits) is still roadmap item 3.

## Human-only (unchanged; see NEEDS.md on main)
Record the video, submit on Devpost, and fact-check the two `[verify]` claims. The
hosted run showed the off-mandate REVIEW coming from the fallback rather than
Claude: check the Render logs and the Anthropic key balance before recording.
