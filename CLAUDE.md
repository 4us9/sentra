# Sentra — CLAUDE.md
Project brief + operating manual for Claude Code. Read this, then STATUS.md and NEEDS.md.
Hackathon deadline: Thu Nov 12 2026, 12:00pm PT = 2:00pm America/Regina.

## 0. PRIME DIRECTIVE
Sentra is **a processor-agnostic firewall for agent-initiated payments**. The agent
never holds processor credentials; it gets one tool (`pay`) and a token scoped to
one human-issued mandate. Sentra inspects every payment before it executes and
refuses the bad ones. PayPal is the primary rail and the hackathon focus; Stripe
proves the core does not depend on any one processor.

Two goals, in this order when they conflict: (1) a working, submittable PayPal AI
Hackathon project; (2) a codebase real developers could adopt.

Design stance (do not weaken): **assume the agent is already compromised**
(prompt injection, poisoned page, poisoned model or package in its supply chain).
Nothing the agent sends is trusted, including text that ends up in our own
dashboard, logs, CSV exports, or the reviewer model's prompt.

Do not fake anything. Simulated is labelled simulated. Unverified is listed as
unverified in STATUS.md.

## 1. INVARIANTS (every change must keep these true; tests enforce most)
1. Default deny. Any error, timeout, malformed input or unparseable model answer
   resolves to BLOCK, REVIEW or ERROR. Never ALLOW.
2. AI can only make a verdict stricter. The model classifies; fixed policy decides.
   Deterministic layers run first; the model is not consulted once one has blocked.
   Signature hits are final.
3. Reserve → execute → commit/release, per mandate. Budget, velocity and drain are
   evaluated against spent + reserved, under `withLock` in src/guard.js. The lock
   is held only for synchronous work; never across a model or processor call.
4. The policy engine (src/policy/, src/intent.js, src/signatures.js) must not
   import or branch on a processor. Processors live in src/processors/ behind the
   PaymentProcessor contract and are the only code that touches credentials.
5. Sandbox / test mode only. PayPal base URL must be the sandbox; Stripe keys must
   be `sk_test_`. Both are refused at load otherwise.
6. Money is compared in integer cents.
7. The ledger is append-only and hash-chained. Never edit or delete an entry;
   resolutions and operator actions are new entries.
8. Mandates are sealed (HMAC) over every policy field including the processor. An
   agent can never create, widen, reroute or switch mandates.
9. Agent-supplied strings never reach `innerHTML`; the CSP stays strict (no inline
   script); CSV cells are formula-safe; logs carry a fingerprint of the purpose,
   never the text, and never a credential.
10. Nothing in test/corpus/attacks.mjs may ever return ALLOW. If a new payload gets
    through, add it to the corpus and fix the firewall, not the test.

## 2. ARCHITECTURE
```
agent ─▶ POST /guard (bearer = mandate-scoped token; rate limited per token)
         guard.js   lock: idempotency → screen (schema, rules, anomaly) → RESERVE
                    no lock: intent (signatures, then Claude or fallback)
                    lock: still usable? (seal, kill switch)
                    no lock: processor.createPayment (idempotent on decision id)
                    lock: COMMIT or RELEASE → append to hash-chained ledger
         ALLOW → processor · BLOCK → refused · REVIEW → human · ERROR → nothing debited
         circuit breaker: N blocks in a window freezes the mandate
operator ─▶ /api/* (issue mandate from a policy file, freeze/reinstate, review, ledger, metrics)
agents   ─▶ sdk/ (HTTP client + types) · mcp/sentra-mcp.js (pay, mandate) · raw HTTP
```
File map is at the bottom of README.md.

## 3. HOW TO WORK THIS REPO
- Keep the tree green. Before every commit: `npm test` (unit, guard, HTTP,
  adversarial; offline; never reads .env) and `npm run typecheck`. CI runs both.
- After any change to the decision path also run the end-to-end demo
  (`npm start`, then `npm run demo`) and confirm each scenario in
  agent/scenarios.js still gives its `expect`, and that verdicts are identical
  across rails.
- Commit small and often with clear messages; push as you go. After each
  milestone that leaves a demo-ready state, tag it `submission-candidate-vN`.
- You (main agent) own the plan, integration, review, tests and commits.
  Sub-agents are for slices with one owner and no shared files (the dashboard is
  `public/*` only). Give each the API contract, its files and an acceptance
  check; review the diff and run the tests before committing its work. Never
  `git add -A` while a sub-agent is editing.
- Keep STATUS.md (done / unverified / needs the human) and NEEDS.md current.
- For anything that needs the human's login (Render, Stripe keys, YouTube,
  Devpost): do the prep, write the exact steps into NEEDS.md, and move on.

## 4. HARD CONSTRAINTS
- No real money, ever. Sandbox / test mode only, on every processor.
- Secrets live in .env (gitignored). Never in git, never in chat, never in logs.
  Do not print .env.
- The Claude intent check costs money per call. The hourly cap
  (SENTRA_LLM_HOURLY_CAP) stays on. Never loop the live demo. Tests never call a
  model or a processor.
- Keep the auditor project ("Checkmate") intact as the backup submission.

## 5. THE HACKATHON (rules that shape the build)
Gate (pass/fail): fits the theme and meaningfully uses BOTH PayPal and AI, with
PayPal central. Submission needs: a working project (a mockup does not qualify),
text description, functional demo (hosted URL or run instructions), public repo
with an open-source LICENSE, demo video under 3 minutes public on YouTube, free
judge access through judging, English, original work.
Judging (equal weights): Technological Implementation, Design, Potential Impact,
Innovation/Idea, Presentation. Ties go to Technological Implementation.
Dates: submit by Nov 12 2026 12:00pm PT. Judging Dec 1–15. Winners ~Dec 21.
Because PayPal must be central: PayPal stays the default rail, the first thing in
the demo, and the one shown executing real sandbox orders.

## 6. THE PITCH (for the write-up and video; text in DEVPOST.md and VIDEO.md)
Business-logic flaws are the payment attack surface that security tooling does not
see: the system does what its code says, and the code allows what it should not.
Evidence gathered earlier in this project (re-check the specifics at the source
before quoting them): the 2025 Sylius PayPal-plugin CVEs (pay $0.01 for a $49
item; cart changed after approval; webhook amount not re-verified) and the Feb
2026 PayPal Working Capital disclosure (a code change exposed customer data for
about six months). Why now: AI agents are beginning to transact, they can be
steered by any content they read, they act at machine speed, and nothing sits
between the agent's decision and the money. Standards such as AP2 define what a
user authorised (the mandate); Sentra is the layer that enforces it, on any rail.

## 7. PRIZE TARGETS (select on Devpost)
Primary: Best Use of Agentic Commerce, Best Use of PayPal + AI, Best Demo Delivery.
Also: Most Creative, Most Impactful. Sponsor lanes: Render (render.yaml, needs the
deploy), AG Grid (the ledger in public/). Upside: overall placement.

## 8. GIT
- Remote: https://github.com/4us9/sentra.git, branch main.
- Before any push confirm `.env` and `data/` contents are not staged (CI has a
  hygiene job that fails if they are tracked).
- A full TypeScript migration, if wanted, happens on a separate branch and only
  after a submission candidate is tagged.

## 9. ROADMAP (after submission; in order)
1. Run the Stripe processor against a real test key; add capture/refund paths.
2. PayPal Payouts rail and recipient → payee mapping, so an ALLOW pays the recipient.
3. Postgres with row locks; shared rate-limit and reservation state; multi-instance.
4. Accept AP2 mandates (verifiable credentials) as input; signed operator approvals.
5. Webhooks on REVIEW and breaker trip; per-operator auth; tenant isolation.
6. Strict type checking; publish the SDK to npm.

## 10. BACKUP PLAN
Hard checkpoint at 12:00pm Regina. If Sentra cannot run its end-to-end demo against
the PayPal sandbox by then, ship the latest `submission-candidate` tag; if none
works, submit the auditor ("Checkmate"). Do not reach the deadline with nothing.
