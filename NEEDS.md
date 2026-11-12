# NEEDS — things only the human can do

In priority order for the 2:00pm Regina deadline. Everything else is in STATUS.md.

## 1. Deploy on Render: DONE (https://sentra-x8zr.onrender.com)
1. render.com → New → **Blueprint** → the `sentra` repo. It reads `render.yaml`.
2. When prompted, enter `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (the same
   sandbox values as your `.env`). Optional: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`.
3. Open the URL. The header must read **PayPal SANDBOX** (not SIMULATED).
4. Put the URL in README "For judges" (replace `_added after deploy_`) and in
   DEVPOST.md, commit, push.

The free tier sleeps when idle and loses the ledger on restart. Both are fine;
open the page a minute before recording or judging.

## 2. Record the video
VIDEO.md is the shot list (under 3:00). Upload public to YouTube; put the link in
DEVPOST.md.

## 3. Submit on Devpost
DEVPOST.md is paste-ready. Checklist:
- [ ] Hosted URL shows PayPal SANDBOX and works
- [ ] Public repo, MIT LICENSE present
- [ ] Video under 3:00, public
- [ ] Description says how PayPal is central and how AI is used (it does)
- [ ] Free judge access through Dec 15: keep the Render service and the PayPal
      sandbox app alive, and leave the Anthropic key funded or remove it (the
      fallback still works)
- [ ] Prize categories selected (CLAUDE.md section 7). Only select Render if deployed.

## 4. Fact-check two claims before quoting them
DEVPOST.md marks them `[verify]`: the Feb 2026 PayPal Working Capital disclosure
(what was exposed, for how long) and the 2025 Sylius PayPal-plugin CVEs. They came
from the earlier session's notes and have not been re-checked at the source.
Fix or soften the wording if the sources say otherwise.

## 5. Optional: a Stripe test key
The Stripe processor is written but has only run simulated. To run it for real:
dashboard.stripe.com → Developers → API keys (Test mode) → copy the `sk_test_...`
secret into `.env` as `STRIPE_SECRET_KEY`, restart, `pnpm demo`. If the Stripe
ALLOW lines come back `ERROR`, tell Claude what the reason says. A live key is
refused at startup.

## 6. Housekeeping
- The Anthropic key is the only thing here that costs money. Each payment that
  passes the deterministic layers is one short Haiku call, capped at
  `SENTRA_LLM_HOURLY_CAP` per hour. A full `pnpm demo` is about 20 calls.
- `.env.example` was deleted from the working tree at some point (probably `mv`
  instead of `cp`). It has been recreated. Use `cp .env.example .env` next time.
