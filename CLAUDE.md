# Sentra — CLAUDE.md
Project brief + operating manual for Claude Code. Read this, then STATUS.md and NEEDS.md.
Deadline: Thu Nov 12 2026, 12:00pm PT = 2:00pm America/Regina.

## 0. PRIME DIRECTIVE
Ship a working, submittable PayPal AI Hackathon project: **Sentra, the firewall
between AI agents and PayPal.** The agent never holds PayPal credentials; it gets
one tool (`pay`) and a token scoped to one human-issued mandate. Sentra inspects
every payment before it executes and refuses the bad ones.

Design stance (do not weaken): **assume the agent is already compromised**
(prompt injection, poisoned page, poisoned model or package in its supply chain).
Nothing the agent sends is trusted, including text that ends up in our own
dashboard or in the reviewer model's prompt.

Beyond the hackathon the goal is a deployable product. Demo quality is the bar for
now; do not fake anything to get there.

## 1. INVARIANTS (every change must keep these true; tests enforce most)
1. Default deny. Any error, timeout, malformed input or unparseable model answer
   resolves to BLOCK, REVIEW or ERROR. Never ALLOW.
2. AI can only make a verdict stricter. Deterministic layers run first; the model is
   not consulted once one of them has blocked. Signature hits are final.
3. Check-and-commit is atomic per mandate (`withLock` in src/guard.js). No payment
   path may read budget/velocity outside the lock.
4. Only src/paypal.js touches PayPal credentials. Sandbox base URL only; it throws
   at load on anything else.
5. Money is compared in integer cents.
6. The ledger is append-only and hash-chained. Never edit or delete an entry;
   resolutions and operator actions are new entries.
7. Mandates are sealed (HMAC). An agent can never create, widen or switch mandates.
8. Agent-supplied strings never reach `innerHTML`; the CSP stays strict (no inline
   script).
9. Simulated mode is always labelled as simulated. Never present SIM- orders as
   PayPal orders.

## 2. ARCHITECTURE
```
agent ──▶ POST /guard (bearer = mandate-scoped token)
          guard.js: lock(mandate) → engine.decide → paypal.executePayment → verify → ledger
          engine: 0 schema (validate.js) → 1 rules → 2 anomaly → 3 intent (intent.js)
          ALLOW → PayPal Orders API v2 (sandbox) · BLOCK → refused · REVIEW → human
          circuit breaker: N blocks in a window freezes the mandate
operator ─▶ /api/* (mandates, freeze/reinstate, review approve/deny, audit verify)
real agents ─▶ mcp/sentra-mcp.js (tools: pay, mandate)
```
File map is at the bottom of README.md.

## 3. HOW TO WORK THIS REPO
- You (main agent) own the plan, integration, review, tests and commits.
- `npm test` must pass before every commit (45 offline tests, no network).
- After any change to the decision path, also run the end-to-end demo:
  `npm start` then `npm run demo`, and confirm the scenario verdicts in
  agent/scenarios.js still match their `expect`.
- Sub-agents: use them only for slices with a single owner and no shared files.
  Current ownership: dashboard = public/* only. Everything under src/ is the main
  agent's. Give each sub-agent the API contract, its owned files, and an acceptance
  check; review the diff and run the tests before committing its work.
- Keep STATUS.md (done / not done) and NEEDS.md (what only the human can do) current.
- Stop at any usage limit. Never spend money to continue.

## 4. HARD CONSTRAINTS
- PayPal SANDBOX only. No real money, ever.
- No paid API usage while building. The Claude intent check is optional and has a
  per-hour call cap (SENTRA_LLM_HOURLY_CAP). Tests never call a model.
- Secrets live in .env (gitignored). Never in git, never in chat.
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

## 6. THE PITCH (for the write-up and video)
Business-logic flaws are the payment attack surface that security tooling does not
see: the system does what its code says, and the code allows what it should not.
No malware, no alarm. Evidence gathered earlier in this project (re-check the
specifics before quoting them on camera): the 2025 Sylius PayPal-plugin CVEs
(pay $0.01 for a $49 item; cart changed after approval; webhook amount not
re-verified) and the 2026 PayPal Working Capital incident (a routine code change
exposed customer data for months). Why now: AI agents are beginning to transact,
they can be steered by any content they read, they act at machine speed, and
nothing sits between the agent's decision and the money. Sentra is that layer.
Each Sylius-class bug has a direct counterpart here: integer-cent validation,
re-verification at approval time, read-back verification of the PayPal order.

## 7. PRIZE TARGETS (select on Devpost)
Primary: Best Use of Agentic Commerce, Best Use of PayPal + AI, Best Demo Delivery.
Also: Most Creative, Most Impactful. Sponsor lanes: Render (render.yaml),
AG Grid (the ledger in public/). Upside: overall placement.

## 8. GIT
- Remote: https://github.com/4us9/sentra.git, branch main. Commit and push as you go.
- Before any push confirm `.env` and `data/` contents are not staged.

## 9. ROADMAP (after submission; in order)
1. Payouts rail: map allowlisted recipients to PayPal payee accounts so an ALLOW
   moves money to the recipient, not just creates an order.
2. Postgres with row locks in place of the JSON store; multi-instance safe.
3. Per-operator auth and signed approvals; webhook on REVIEW and on breaker trip.
4. Mandates in AP2 / verifiable-credential form so other parties can verify them.
5. Wrap PayPal's own Agent Toolkit so Sentra is a drop-in policy layer for it.

## 10. BACKUP PLAN
Hard checkpoint at 12:00pm Regina. If Sentra cannot run its end-to-end demo against
the PayPal sandbox by then, submit the auditor ("Checkmate") instead. Do not reach
the deadline with nothing.
