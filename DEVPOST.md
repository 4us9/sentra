# Devpost submission text

## Sentra — the firewall between AI agents and the money

**Tagline:** Every payment an AI agent attempts is inspected before it executes.
Good ones go through to PayPal. Hijacked ones never leave.

### Inspiration

An agent that can pay will read web pages, emails
and tool output, and any of them can tell it what to do. To the processor a
hijacked agent is indistinguishable from a healthy one: valid credentials,
valid API call. Standards like AP2 describe what a user *authorised*, as a
signed mandate. Something still has to enforce that mandate at the moment money
moves. That is what we built.

### What it does

Sentra sits between an AI agent and the payment processor.

- The agent never holds PayPal credentials. It gets one tool, `pay`, and a token
  scoped to one human-issued **mandate**: budget, per-payment cap, allowed
  recipients, velocity, expiry, purpose.
- Every payment passes four layers, strictest wins, default deny: **schema**,
  **hard rules**, **behavioural anomaly**, **intent**.
- The verdict is **ALLOW** (executed on PayPal, then read back and verified),
  **BLOCK** (PayPal is never called), or **REVIEW** (held for a human).
- Repeated blocks trip a **circuit breaker** that freezes the agent until a human
  reinstates it. A human **kill switch** stops payments already in flight.
- Every decision is appended to a **hash-chained ledger** that can be verified
  offline and exported.

The dashboard's Attack Lab lets you play the attacker: fire a prompt-injected
$5,000 drain, a gift-card cash-out that passes every numeric limit, a look-alike
merchant id, a negative-amount "refund", a double-spend race, a velocity burst,
or craft your own payment and try to get it through.

### How we built it

- **PayPal** is the primary rail and the thing being protected: OAuth client
  credentials, Orders API v2, `PayPal-Request-Id` idempotency keyed on the
  decision id, and read-back verification of each order. Sandbox only; Sentra
  refuses to start on any other PayPal URL.
- **AI** is both the subject and a component. The product guards AI agents, and
  the intent layer uses **Claude** to classify each payment as in scope, out of
  scope, or suspicious. Fixed policy turns that class into a verdict.
- **The model can only say no.** Deterministic hijack signatures run first and
  are final. The model is never consulted once a rule has blocked. Its output is
  parsed strictly; anything unexpected becomes REVIEW. A compromised reviewer
  model cannot approve anything.
- **Reserve → execute → commit.** Budget is reserved under a per-mandate lock,
  the model and PayPal are called with no lock held, then the reservation is
  committed or released. Concurrent payments cannot oversubscribe a budget and a
  slow model never stalls other agents.
- **Processor-agnostic core.** The engine does not know which rail is behind it.
  PayPal and Stripe implement one small interface, and the demo runs the same
  mandate and attacks on both and checks the verdicts are identical.
- **Developer surface:** an SDK (three lines, typed), an MCP server (any MCP
  agent gets `pay` and no keys), a proxy mode for wrapping an existing payment
  tool, and policies as versioned JSON config.
- **Operations:** queryable ledger with CSV export, Prometheus metrics (block
  rate, spend by processor, p95 decision latency), per-agent rate limits,
  redacting logs.
- A TypeScript workspace runs the Fastify service and Next.js operator console.
  The console uses TanStack Table for the ledger. A Render blueprint hosts the service.

### Challenges

- Making the AI layer safe to depend on. The reviewer model reads attacker-
  controlled text, so it had to be impossible for it to widen a verdict. Having
  it classify rather than decide, and putting deterministic signatures in front
  of it, is what made that true.
- The first live run showed the model was right to call an off-purpose purchase
  a violation, which meant nothing was ever held for review. Splitting
  "suspicious" from "out of scope" and letting the mandate decide what out of
  scope means fixed the product, not just the demo.
- Concurrency. Holding a lock across a model call and a PayPal call is correct
  and slow; not holding it is fast and wrong. Reservations are the answer.

### Accomplishments

- 170+ automated tests, including an **adversarial suite of 93 attack payloads
  that must never be allowed**, run on every commit in CI. The deterministic tier
  must hold even with the reviewer model fully compromised.
- A live end-to-end run: real PayPal sandbox orders for legitimate payments, and
  every attack stopped before PayPal was called.
- The operator console treats agent-supplied text as hostile too: no `innerHTML`,
  strict CSP, formula-safe exports.

### What we learned

The useful question is not "is this agent trustworthy" but "what can this agent
do if it is not". Removing the credentials from the agent and putting a small,
boring, deterministic gate in front of the money does more than any amount of
prompt hardening.

### What's next

Payouts so an ALLOW pays the recipient directly; accepting AP2 mandates as
input; Postgres with row locks for multi-instance deployments; signed operator
approvals and webhooks; more rails.

### Try it

- Live: https://sentra-x8zr.onrender.com
- [Watch the 2:15 demo](https://youtu.be/4RoAkJbKLI4). The recording uses simulated payments and the fallback intent check.
- Code: https://github.com/4us9/sentra (MIT). `corepack enable && pnpm install && pnpm start`, then
  `pnpm demo`. Runs fully offline in simulated mode with no credentials.

### Built with

paypal, claude, anthropic, node.js, express, ag-grid, render, mcp, stripe

### Prize categories

Best Use of Agentic Commerce · Best Use of PayPal + AI · Best Demo Delivery ·
Most Creative · Most Impactful · Best Use of Render · Best Use of AG Grid
