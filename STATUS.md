# STATUS

Updated Nov 12 2026, morning (Regina). Deadline 2:00pm Regina.

## Done and verified
- **Firewall core** rebuilt: schema → rules → anomaly → intent, strictest wins,
  default deny. `npm test`: 45/45, offline.
- **Guard chokepoint**: mandate-scoped agent tokens, atomic check-and-commit per
  mandate (race-tested), idempotency keys, circuit breaker, kill switch, human
  review with re-verification at approval time.
- **Tamper evidence**: HMAC-sealed mandates, hash-chained ledger (`/api/audit/verify`).
- **End-to-end demo** (`npm start` + `npm run demo`) run against SIMULATED PayPal:
  every scenario in agent/scenarios.js returns its expected verdict, budget never
  exceeded, ledger intact.
- **MCP server** (`mcp/sentra-mcp.js`): initialize, tools/list, `pay`, `mandate`
  exercised over stdio against a running Sentra.
- **Render blueprint** (`render.yaml`), `.env.example`, README (judges section,
  attack table, API), VIDEO.md shot list, NEEDS.md.
- **Dashboard** (`public/`, AG Grid Community 33.3.2 with SRI): Attack Lab, craft
  your own payment, review queue, kill switch / reinstate, ledger with check trace
  and CSV export. Checked in a browser at 1440px: scenarios, review queue, ledger,
  no console or CSP errors; an HTML/script payload in recipient and purpose renders
  as inert text. Not checked in a browser: operator-token prompt, the tampered-ledger
  chip, SANDBOX and Claude chips, ERROR verdict, layouts under 1280px.
- Committed and pushed to `origin/main`.

## Done, not yet verified
- **Real PayPal sandbox execution.** The Orders call, `PayPal-Request-Id`
  idempotency and read-back verification are written but have only run in
  simulated mode: there are no credentials on this machine. First thing to check
  once `.env` exists (NEEDS.md step 1).
- **Claude intent check.** Written against the Anthropic SDK; never called (no key,
  and building must not spend money). Parsing and fallback paths are unit-tested.

## Not done (needs the human; see NEEDS.md)
- PayPal sandbox credentials in `.env`, then the real end-to-end run.
- Render deploy and the hosted URL in the README.
- Demo video, Devpost submission.

## Removed in the refactor
- `NEXT_STEPS.md` (folded into NEEDS.md, VIDEO.md, README).
- `src/db.js` → `src/store.js`; `src/llm.js` → `src/intent.js`;
  `agent/injection.js` → `agent/scenarios.js`; the old 11-case test file.
- The "no allowlist means allow anyone" behaviour. A mandate now requires one.
