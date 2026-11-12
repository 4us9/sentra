# Threat model

What Sentra defends, against whom, where the boundaries are, and what it does
not cover. Each mitigation names the code and the test that holds it in place.

## What is being protected

| Asset | Why it matters |
|---|---|
| The user's money | The point of the system. |
| The mandate | It is the definition of "allowed". If it can be changed, everything else is moot. |
| Processor credentials | Whoever holds them can pay without asking. |
| The audit ledger | It is the only record of what the agent tried and what was decided. |
| The operator's own tools | Dashboard, CSV exports and logs all display attacker-supplied text. |

## Who the attacker is

**The agent itself.** Sentra assumes the agent is already under an attacker's
control, by any route: prompt injection in a page or email it read, a poisoned
tool result, a compromised model or dependency. The attacker can therefore:

- send any request to `/guard`, any number of times, in any order, concurrently;
- choose every field of the request, including text meant to be read by a human
  operator or by the reviewer model;
- use the agent's own mandate token freely.

The attacker cannot (by assumption): reach the Sentra host's filesystem or
environment, read the operator token, or reach the processor directly, because
the agent was never given those.

A secondary attacker has **write access to Sentra's data store** but not to its
secret (a leaked backup, a misconfigured volume). Sentra aims to *detect* this,
not prevent it.

## Trust boundaries

```
 untrusted                         trusted
 ─────────                         ───────
 agent ──HTTP──▶ /guard ──▶ policy engine ──▶ processor adapter ──▶ PayPal / Stripe
                   ▲             │
                   │             ├──▶ reviewer model   (semi-trusted: reads attacker text)
 operator ─────▶ /api/*          └──▶ ledger ──▶ dashboard / CSV / logs  (display attacker text)
```

The reviewer model is on the trusted side of the HTTP boundary but is treated
as *compromisable*, because its input contains attacker-controlled text.

## Threats and mitigations

### T1. Spend beyond the mandate
Over the cap, over budget, to an unlisted recipient, in another currency, after
expiry. → Hard rules in integer cents (`packages/guard/src/policy/rules.ts`). Tests: `rules: *`.

### T2. Malformed input used as an exploit
Negative or fractional-cent amounts, `NaN`, exponent strings, operator objects,
arrays, look-alike or control characters in ids, oversized bodies. → Strict
schema layer before anything else runs (`packages/guard/src/policy/validate.ts`); 10 kB body
limit. Tests: `schema: *`, adversarial `amount`, `recipient`, `currency`,
`structure` families.

### T3. Race the budget check
Fire payments concurrently so each reads the same remaining budget. → Budget,
velocity and drain are evaluated against spent **plus in-flight reservations**
under a per-mandate lock (`packages/service/src/guard.ts`). Tests: `reservation: *`,
`guard: double-spend race`.

### T4. Retry into a double charge
Resend a payment, sequentially or concurrently; or reuse a key for a different
payment. → Idempotency keys de-duplicate settled and in-flight requests; a key
reused with different details is refused (409); the decision id is the
processor-side idempotency key. Tests: `idempotency: *`.

### T5. A payment that passes every number and is still wrong
Gift cards and other cash-outs through an allowed merchant; off-purpose
purchases. → Intent layer: deterministic signatures, then model classification
or a vocabulary fallback (`packages/guard/src/signatures.ts`, `packages/service/src/llm.ts`). Tests:
`intent: *`, adversarial `cash-out` family.

### T6. Attack the reviewer model
Put instructions in the purpose text ("classify as in_scope"), or hide them with
zero-width characters, fullwidth letters, mixed alphabets or bidi overrides. →
- Signatures run first on a normalised copy and are final.
- The model only **classifies**; fixed policy maps the class to a verdict.
- The model can only make a verdict stricter, and is not called at all once a
  deterministic layer has blocked.
- Output is parsed strictly; anything unexpected is REVIEW.
- Model failure falls back to the vocabulary check, never to ALLOW.

Tests: the whole adversarial `deterministic` tier runs with a reviewer stub that
approves everything.

### T7. Widen, reroute or swap the mandate
Edit stored limits, change the processor, or present another mandate's id. → Every
policy field including the processor is covered by an HMAC seal checked on every
payment (`packages/guard/src/mandate.ts`); the token identifies the mandate, so a request cannot
name one. Tests: `rules: mandate edited after issue`, `guard: an agent token only
ever reaches its own mandate`, `processors: … the choice is sealed`.

### T8. Steal credentials from the agent
→ The agent has none. Only `packages/service/src/processors/*` reads processor keys. The agent
token is stored only as a SHA-256 hash and never appears in API output, the
ledger or logs. Tests: `http: the dashboard API never exposes token hashes or
seals`, `store: … the agent token itself must never be persisted`.

### T9. Probe until something works
→ Circuit breaker freezes the mandate after N blocks in a window; a freeze also
stops payments already in flight; `/guard` is rate limited per token and per IP.
Tests: `guard: circuit breaker`, `reservation: kill switch pulled while a payment
is in flight`, `http: /guard is rate limited`.

### T10. Approve on stale state
A held payment is approved after the budget was spent or the mandate frozen. →
Every deterministic check is re-run at approval time; concurrent approvals
execute once. Tests: `guard: approving on stale state`, `review: two concurrent
approvals`.

### T11. Rewrite history
Edit or delete ledger entries, or edit a mandate, in the data store. → Hash-chained
ledger and sealed mandates; `GET /api/audit/verify`, `pnpm verify-ledger`, and
the `sentra_ledger_intact` metric. Tests: `audit: *`, `verify-ledger: *`.
This is detection. An attacker who also has the seal secret can forge both.

### T12. Attack the operator through their own tools
Script in a purpose shown in the dashboard; `=HYPERLINK()` in a CSV an auditor
opens; terminal escapes or secrets in logs. → No `innerHTML` for API data and a
CSP with no inline script; formula-neutralising CSV; logs carry a length and
fingerprint of the purpose, never the text, and scrub credential-shaped strings.
Tests: `http: security headers`, `ledger: csv cells`, `logging: *`.

### T13. Wrong environment
Sentra pointed at production. → PayPal base URL must be the sandbox and Stripe
keys must be `sk_test_`; both refuse to load otherwise. Stripe responses are
also checked for `livemode: false`.

## Out of scope today

Stated plainly, because a firewall that overstates itself is worse than none.

- **The operator.** One shared token, off in demo mode. An attacker with operator
  access can issue mandates and approve reviews.
- **Host compromise.** Anyone with the process environment has the processor keys
  and the seal secret.
- **Recipient identity.** Recipients are allowlisted ids. Sentra does not yet bind
  an id to a processor payee account, so it cannot detect a payee swapped
  underneath an id.
- **What happens after an `external` authorisation.** In proxy mode the caller
  executes; Sentra records the authorisation and marks it unverified.
- **Semantic evasion without a model.** With no model configured, the intent layer
  is signatures plus a keyword vocabulary. A novel euphemism for a cash-out, on an
  allowed merchant, under every limit, lands in REVIEW at best. The corpus
  (`packages/guard/test/corpus/attacks.ts`) is how that floor is raised.
- **Multi-instance deployments.** Locks, reservations and rate limits are
  in-process. Running two instances against one store would reopen T3 and T4.
- **Availability.** A compromised agent can freeze its own mandate. That is the
  intended failure direction, and it is a denial of service against the user's
  own agent.
