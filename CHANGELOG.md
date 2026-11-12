# Changelog

## 0.4.0 — 2026-11-12

TypeScript monorepo release.

- **Packages.** The pure guard engine, storage adapters, Fastify service, SDK and
  MCP server now live in independently type-checked workspace packages. The
  operator console is a Next.js app in `apps/web`.
- **Storage.** Added the `Store` contract, JSON/file and Prisma/Postgres
  implementations, ordered Postgres writes and an advisory single-writer lock.
  The verifier reads Postgres through a separate read-only path, so it does not
  contend with the service writer.
- **Service.** Fastify replaces the legacy server, with CORS, storage health and
  scoped, revocable operator API keys.
- **Delivery.** CI runs build, typecheck and tests on Node 20/22/24 with
  Postgres. Render builds through pnpm; a service Dockerfile is included.

Breaking: use pnpm workspaces and package imports (`@sentra/sdk`, `@sentra/mcp`)
instead of the removed root `sdk/` and `mcp/` trees.

## 0.3.0 — 2026-11-12 (`submission-candidate-v2`)

Processor-agnostic core and the developer surface.

- **Processors.** `PaymentProcessor` contract in `src/processors/`. PayPal
  (sandbox, Orders v2) and Stripe (test mode, PaymentIntents) implement it; an
  `external` rail authorises without executing, for proxying an existing tool.
  The mandate names its rail and the choice is sealed.
- **Reserve → execute → commit.** The guard holds the mandate lock only for
  synchronous work. In-flight reservations count toward budget, velocity and
  drain. A freeze stops payments already in flight.
- **Intent.** The model classifies (`in_scope`, `out_of_scope`, `suspicious`);
  the mandate's `outOfScope` setting decides what out-of-scope becomes. Default
  model `claude-haiku-5-5`.
- **Signatures.** Moved to `src/signatures.js`. NFKC normalisation; hidden
  characters and mixed-alphabet words are hostile; links, formulas and markup in
  a purpose are hostile; wider cash-out coverage.
- **Idempotency.** Concurrent requests with one key execute once. A key reused
  for a different payment is refused (409).
- **Policy-as-config.** Versioned JSON policies with a strict validator; mandates
  are issued from a named policy.
- **SDK** with TypeScript types; **MCP** server reports the rail.
- **Ledger.** Query API, formula-safe CSV export, `decidedBy` on every decision,
  operator actions (issue, freeze, reinstate) recorded, `npm run verify-ledger`.
- **Metrics.** `/api/metrics` and Prometheus `/metrics`.
- **Hardening.** Per-token and per-IP rate limits, redacting decision log,
  generic 500s, indexed store.
- **Dashboard.** Policy picker, processor toggle, metrics strip, intent reason on
  the Attack Lab cards, processor filter, server CSV export.
- **Quality.** Adversarial corpus (93 payloads that must never be allowed), HTTP
  and scenario regression suites, `tsc --checkJs`, GitHub Actions on Node
  20/22/24 with a secrets-hygiene job.
- **Docs.** Threat model, processor guide, integration examples.

- **Strict types.** `tsc --strict --checkJs` is clean; domain types in
  `src/types.d.ts`.
- **Fixed during the typing review:** `POST /api/mandates` accepted arbitrary
  fields including `id`, so an existing mandate could be replaced and widened
  (now an allowlist of `processor` and `user`); a replaced mandate's old token
  kept working; a demo reset during an in-flight payment threw and lost the
  record; a failed joined request was labelled as a replay.

Breaking: decisions carry `processor`, `payment` and `paymentId` instead of
`paypal` and `paypalOrderId`. `src/paypal.js` is now `src/processors/paypal.js`.
Reason layer `paypal` is now `processor`.

## 0.2.0 — 2026-11-12 (`submission-candidate-v1`)

Rebuild of the firewall core.

- Four-layer engine (schema, rules, anomaly, intent), default deny.
- Mandate-scoped agent tokens; agents can no longer create their own mandate.
- Atomic check-and-commit per mandate; idempotency keys; circuit breaker; kill
  switch; human review with re-verification at approval time.
- HMAC-sealed mandates; hash-chained audit ledger.
- PayPal sandbox executor with read-back verification; labelled simulated mode.
- MCP server; AG Grid dashboard with an Attack Lab; strict CSP, no `innerHTML`.
- Fixed from 0.1.0: negative amounts passed the cap and budget checks;
  concurrent payments could both pass one budget check; agent-supplied text was
  rendered with `innerHTML`; an empty allowlist allowed any recipient.

## 0.1.0 — 2026-11-12

Initial scaffold: rules, anomaly checks, LLM intent with a keyword fallback,
`/guard`, demo agent, table dashboard.
