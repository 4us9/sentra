<img src="docs/assets/sentra-firewall-banner.png" alt="An AI payment request passing through Sentra's protected gateway into verified ledger entries" width="100%" />

# Sentra

**[Watch the 2:15 PayPal AI Hackathon demo on YouTube](https://youtu.be/4RoAkJbKLI4)**

### The firewall between AI agents and the money.

An AI agent should be able to buy groceries—not empty an account because a web page
prompt-injected it. Sentra sits between an agent and every payment rail. It checks
each attempted payment against a human-issued mandate, blocks unsafe requests, and
writes every decision to a tamper-evident ledger.

**[Open the live demo](https://sentra-x8zr.onrender.com)** · **[Read the threat model](docs/THREAT_MODEL.md)** · **[See the architecture](#how-it-works)**

```
 AI agent ── pay() ──▶  Sentra ── ALLOW ──▶ PayPal sandbox / Stripe test mode
                           │
                           ├── BLOCK   nothing reaches the processor
                           ├── REVIEW  a person decides
                           └── LEDGER  every decision is hash-chained
```

## See it work in one minute

1. Open the [live demo](https://sentra-x8zr.onrender.com) and issue a grocery
   mandate. That is the human authorising a narrow budget, known merchants, and a
   payment cap.
2. In **Attack Lab**, run *Weekly groceries*. It is allowed and produces a
   sandbox/test payment record.
3. Run *Prompt-injected drain* or *Gift card cash-out*. Sentra refuses it before
   any processor call.
4. Open the **Ledger** to see the exact rule, signature, or intent check that
   made the decision—and verify the hash chain.

No real money moves. PayPal is sandbox-only; Stripe is test-mode-only.

## Why Sentra exists

An agent with valid payment credentials can be redirected by a poisoned web page,
email, tool response, model, or package. To the payment processor it still looks
like a valid request. Sentra assumes the agent is already compromised:

- the agent never receives processor credentials;
- it receives one mandate-scoped token and one tool: `pay`;
- fixed rules and deterministic attack signatures run before AI classification;
- the AI can only make a decision stricter—never approve a payment that policy
  blocked.

| What the agent tries | What Sentra does |
| --- | --- |
| `$5,000` transfer to an unknown wallet | **BLOCK** — cap, budget, and recipient allowlist fail |
| $70 gift card at an approved grocery store | **BLOCK** — cash-out signature is final |
| Headphones on a grocery mandate | **REVIEW** — policy is technically valid but outside human intent |
| Two concurrent payments that exceed the budget together | **BLOCK** — in-flight reservations close the race |

## How it works

Every request passes through four layers. The strictest result wins; the default
is no.

| Layer | Question | Result on failure |
| --- | --- | --- |
| 0 · Schema | Is this a valid, ordinary payment request? | BLOCK |
| 1 · Rules | Is it within the sealed mandate—cap, budget, recipients, velocity, rail? | BLOCK |
| 2 · Anomaly | Does it look like a drain or an abnormal spike? | BLOCK |
| 3 · Intent | Would the human recognise this purchase as what they authorised? | BLOCK or REVIEW |

The service uses **reserve → execute → commit/release**: concurrent payments see
each other before processor execution, while slow model and processor calls never
hold the mandate lock. Every completed decision is appended to an immutable,
hash-chained audit ledger.

## Run locally

Requires Node 20+ and Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm start                 # API at http://localhost:3000
pnpm demo                  # runs the scripted attacks on both rails
```

In a separate terminal, run the operator console:

```bash
SENTRA_WEB_ORIGIN=http://localhost:3100 PORT=4000 pnpm start
NEXT_PUBLIC_SENTRA_API=http://localhost:4000 pnpm --filter @sentra/web dev
```

Run the full quality gate:

```bash
pnpm turbo run build typecheck test
```

## Integrate an agent

```ts
import { Sentra } from '@sentra/sdk';

const sentra = new Sentra({
  url: process.env.SENTRA_URL,
  agentToken: process.env.SENTRA_AGENT_TOKEN, // one mandate; no processor keys
});

const decision = await sentra.guard({
  amount: 40,
  recipient: 'merchant_freshmart',
  purpose: 'weekly groceries',
});

if (decision.verdict === 'ALLOW') console.log(decision.paymentId);
```

Use `sentra.protect()` to wrap an existing payment tool, or run the MCP server
for MCP-capable agents. See the [integration examples](examples/README.md) and
the [SDK reference](packages/sdk/README.md).

## Built for trust

- **Processor-agnostic:** PayPal, Stripe, and an external-authorisation rail use
  the same guard engine and produce identical verdicts for the same policy.
- **Tamper-evident:** mandates are HMAC-sealed; decisions are append-only and
  hash-chained. Run `pnpm verify-ledger` to check a file ledger or Postgres.
- **Production-shaped:** Fastify, CORS, scoped/revocable operator keys, a
  file-store fallback, and Prisma/Postgres with a single-writer advisory lock.
- **Adversarially tested:** 93 hostile payloads must never be allowed, including
  Unicode look-alikes, hidden instructions, parser tricks, races, and reviewer
  prompt injection.

## Project map

| Area | Location |
| --- | --- |
| Decision engine, policies, mandates, audit chain | [`packages/guard`](packages/guard) |
| File and Postgres storage | [`packages/db`](packages/db) |
| Fastify API, processors, verifier and demo | [`packages/service`](packages/service) |
| Typed client and MCP server | [`packages/sdk`](packages/sdk) · [`packages/mcp`](packages/mcp) |
| Operator console | [`apps/web`](apps/web) |

## Deploy

`render.yaml` builds the workspace on Render. For durable storage, attach Render
Postgres, set `DATABASE_URL`, and run `pnpm --filter @sentra/db migrate` as a
pre-deploy command. Deploy `apps/web` to Vercel with `NEXT_PUBLIC_SENTRA_API`
set to the service URL and `SENTRA_WEB_ORIGIN` set on the service.

For design decisions, attack coverage, and explicit limitations, see
[STATUS.md](STATUS.md), [SECURITY.md](SECURITY.md), and the
[threat model](docs/THREAT_MODEL.md).

MIT licensed.
