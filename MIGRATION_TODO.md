# TypeScript monorepo migration — complete

Completed on `ts-monorepo`.

- pnpm workspaces and Turborepo organize the guard, storage, Fastify service,
  SDK, MCP server, and Next.js operator console.
- The guard, HTTP, auth, scenario and adversarial suites are ported to Vitest.
  CI runs build, type checking and tests on Node 20/22/24 with Postgres.
- The Next.js app was checked against Fastify with CORS at desktop and mobile
  widths. The old JavaScript source, SDK, MCP, agent, scripts and tests are gone.
- `verify-ledger` verifies either the JSON ledger or Postgres. Its Postgres read
  path is read-only and never takes the service's advisory writer lock.
- Render uses pnpm; `packages/service/Dockerfile` supports container hosting;
  README documents Render Postgres and Vercel configuration.

Run all workspace checks with:

```bash
corepack enable
pnpm turbo run build typecheck test
```

Operational follow-up is deliberately outside the migration: configure production
credentials and hosting, record the demo video, and submit the project.
