# Security

Sentra is a security control, so problems in it are security problems.

## Reporting

Open a GitHub issue for anything that is safe to discuss in public. For a bypass
(a payment that should have been stopped and was allowed, a way to widen a
mandate, a way to forge or edit the ledger undetected), please use GitHub's
private vulnerability reporting on this repository instead of a public issue.

A good report is a payload. If you have a request that comes back `ALLOW` and
should not, the most useful form is a new entry for
[`test/corpus/attacks.mjs`](test/corpus/attacks.mjs): it becomes a permanent
regression test once fixed.

## What counts

In scope: anything in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) under
"Threats and mitigations" that does not hold.

Known and documented, not vulnerabilities: the items under "Out of scope today"
in the same file (single shared operator token, in-process locks, recipient ids
not bound to payee accounts, semantic evasion with no model configured).

## Operating it safely

- Sandbox and test mode only. Sentra refuses a non-sandbox PayPal URL and a live
  Stripe key at startup; do not patch that out.
- Set `SENTRA_ADMIN_TOKEN` and `SENTRA_SECRET` on anything reachable from the
  internet. With no admin token, anyone who can reach the server can issue
  mandates and approve held payments.
- Keep `SENTRA_LLM_HOURLY_CAP` set if a model key is configured.
- Run one instance per data store.
- Run `npm run verify-ledger` against backups; alert on the
  `sentra_ledger_intact` metric.
