# NEEDS — things only the human can do

In order. Everything else is done or listed in STATUS.md.

## 1. PayPal sandbox credentials (blocks the real end-to-end run)
1. developer.paypal.com → Apps & Credentials → **Sandbox** → open or create a REST app.
2. `cp .env.example .env`, paste Client ID and Secret into `.env`. Do not paste them in chat.
3. `npm start` should print `PayPal: SANDBOX (real sandbox orders)`.
4. `npm run demo`: the ALLOW lines must show real order ids (not `SIM-`).

If the first ALLOW comes back `ERROR`, the reason line carries PayPal's response.
The PayPal call has only been exercised in simulated mode so far, so this is the
one step that can still surprise us. Tell Claude what it says.

## 2. Push access
The repo is committed locally. If the push did not go through (see STATUS.md), run:

```bash
git push -u origin main
```

## 3. Deploy on Render
Render → New → Blueprint → the `sentra` repo (uses `render.yaml`). Enter the two
PayPal sandbox values when asked. Put the URL into README "For judges" and Devpost.

## 4. Optional: Claude intent check
Add `ANTHROPIC_API_KEY` to `.env` / Render. This is the only thing in the project
that costs money: one short call per payment that passes the deterministic layers,
capped by `SENTRA_LLM_HOURLY_CAP`. Set `ANTHROPIC_MODEL=claude-haiku-5-5` to keep it
cheap. Without a key the demo still works; say "intent check", not "the LLM", on camera.

## 5. Record and submit
VIDEO.md has the shot list. Then the Devpost form: description, repo URL, hosted
URL, YouTube link, prize categories (CLAUDE.md section 7).

Devpost checklist (all required):
- [ ] Project runs as shown; not a mockup (hosted instance must show SANDBOX, not SIMULATED)
- [ ] Public repo with source and the MIT LICENSE
- [ ] Hosted URL and run instructions in the README
- [ ] Video under 3:00, public on YouTube
- [ ] Description states how PayPal is central (Orders API executes every allowed payment) and how AI is used (guards AI agents; Claude intent check)
- [ ] Free judge access through Dec 15 (keep the Render service and sandbox app alive)
- [ ] English; prize categories selected

## 6. Fact-check before quoting
The Sylius CVE details and the PayPal Working Capital incident in CLAUDE.md
section 6 came from the earlier session. Re-check them at the source before saying
them on video or in the write-up.
