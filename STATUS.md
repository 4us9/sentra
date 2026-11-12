# STATUS

Updated Nov 12 2026 (Regina time).

## 0.4.0 TypeScript monorepo

- The implementation is now a pnpm workspace: `@sentra/guard`, `@sentra/db`,
  `@sentra/service`, `@sentra/sdk`, `@sentra/mcp`, and the Next.js app
  `@sentra/web`. The legacy root JavaScript tree has been removed.
- The guard has 171 tests, DB 3 file-store tests (plus Postgres contract tests
  when `SENTRA_TEST_DATABASE_URL` is supplied), service 177 tests, SDK 9, MCP
  10, and web 6. Builds and strict package type checks are green.
- The service tests include API keys, durability failure, CORS, the adversarial
  corpus and the offline ledger verifier. The verifier supports both the JSON
  store and Postgres; its Postgres reader never takes the writer lock.
- The Next.js landing, dashboard, Attack Lab and ledger were checked against the
  Fastify service with CORS at 1440px and 390px; no browser console errors.
- CI uses pnpm, Node 20/22/24 and a Postgres service. Render builds the workspace
  with pnpm; `packages/service/Dockerfile` supports container deployment.

## Still human-only

1. Record and upload the demo video (`VIDEO.md`).
2. Submit the Devpost entry (`DEVPOST.md`) and fact-check its marked claims.
3. Configure Render Postgres and/or Vercel environment variables for production
   hosting if desired; see README’s deploy section.
