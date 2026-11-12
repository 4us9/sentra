# STATUS

Updated Nov 12 2026 (Regina time). Deadline 2:00pm Regina.
Known-good tags: `submission-candidate-v1`, `submission-candidate-v2` (see the end).

## Done and verified

**Verified live (real PayPal sandbox + Claude, this machine)**
- `npm run demo` end to end: legitimate payments create real PayPal sandbox orders;
  every attack is stopped before PayPal is called; the ledger verifies.
- Claude intent check (`claude-haiku-5-5`): the off-mandate purchase is classified
  out of scope and held for REVIEW with a one-sentence reason tagged `[llm]`; an
  injection aimed at the reviewer is classified suspicious; signatures still win
  over the model (the gift-card case never reaches it).
- Same mandate and attacks on the PayPal rail and the Stripe rail give identical
  verdicts (Stripe simulated, see below).

**Verified by automated tests (`npm test`, offline, also green in GitHub Actions on Node 20/22/24)**
- Policy engine layer by layer: schema, hard rules (integer cents), anomaly, intent.
- Adversarial suite: 93 payloads that must never be ALLOWED. Deterministic tier
  holds with a fully compromised reviewer model; semantic tier with no model.
  Legitimate controls still pass.
- Guard: token auth, mandate isolation, reserve → execute → commit/release,
  double-spend race closed, processor calls overlap (lock not held), failed
  processor releases the reservation, kill switch stops an in-flight payment,
  idempotency (sequential and concurrent), circuit breaker, human review with
  re-verification, concurrent approvals execute once.
- Tamper evidence: HMAC-sealed mandates (including the processor), hash-chained
  ledger, `npm run verify-ledger` (exit 0 / 1 / 2).
- HTTP surface: security headers, malformed and oversized bodies, no token hashes
  or seals in API output, per-token rate limiting, generic 500s.
- SDK over real HTTP (`guard`, `guardOrThrow`, `mandate`, `protect`), policy files
  and the strict validator, ledger query and formula-safe CSV, JSON and
  Prometheus metrics, log redaction.
- `npm run typecheck` (tsc --checkJs, non-strict) is clean.

**Verified by hand**
- MCP server over stdio (initialize, tools/list, `pay`, `mandate`) against a
  running Sentra, on both rails.
- `examples/quickstart.js` and `examples/protect-existing-tool.js` run.

## Done, not verified
- **Stripe against a real test key.** `src/processors/stripe.js` (PaymentIntents,
  confirmed against Stripe's test payment method, `Idempotency-Key`, read-back
  check, live keys refused) has only run in simulated mode. Needs a `sk_test_`
  key: NEEDS.md step 5.
- **Render deploy.** `render.yaml` is written and unexercised. NEEDS.md step 1.
- **Dashboard paths not clicked in a browser:** see the dashboard entry below.

## Dashboard
See the "Dashboard" section at the end of this file for what was and was not
checked in a browser after the multi-processor upgrade.

## Needs the human (NEEDS.md)
1. Render deploy and the hosted URL in README / DEVPOST.md.
2. Demo video (VIDEO.md).
3. Devpost submission (DEVPOST.md is paste-ready).
4. Fact-check the two `[verify]` claims in DEVPOST.md.
5. Optional: Stripe test key.

## What changed in this pass (after submission-candidate-v1)
- Processor-agnostic core: `src/processors/` (PayPal, Stripe, external), mandate
  picks the rail, sealed.
- Guard rewritten around reservations; engine split into `screen` / `conclude`.
- Intent: the model classifies, the mandate's `outOfScope` policy decides.
- Signatures: Unicode normalisation, hidden-character and mixed-script detection,
  links / formulas / markup, wider cash-out list.
- SDK with types, policy-as-config, rate limiting, ledger query + CSV, metrics,
  `verify-ledger`, redacting decision log, examples, CI, typecheck.
- Scenario order changed so the race shows one payment winning.
- Removed: `src/paypal.js` (now `src/processors/paypal.js`), `NEXT_STEPS.md`
  (folded into NEEDS.md, VIDEO.md, README).

## Tags
- `submission-candidate-v1`: single-rail PayPal firewall, live-verified, adversarial suite.
- `submission-candidate-v2`: processor-agnostic core, SDK, policies, ledger/metrics, CI.
