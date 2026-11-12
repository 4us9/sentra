# Demo video — shot list (under 3:00, public on YouTube)

1080p screen recording with voiceover. Have the dashboard open on a fresh state
(**Reset demo**, then **New mandate**) and PayPal showing SANDBOX in the header.
Write nothing new on camera; every beat below is one click.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:20 | Title: *Sentra — the firewall between AI agents and PayPal* | "AI agents are starting to spend money. Anything an agent reads can tell it what to do, and to PayPal a hijacked agent looks exactly like a healthy one. Nothing sits between the agent's decision and the money. Sentra does." |
| 0:20–0:40 | Mandate panel | "The human sets a mandate: three hundred dollars, groceries, seventy-five per payment, two merchants. The agent never gets PayPal credentials. It gets one tool, pay, and a token for this mandate only." |
| 0:40–1:00 | Attack Lab → **Weekly groceries**; show order ids in the ledger | "Normal shopping goes straight through. These are real PayPal sandbox orders." |
| 1:00–1:30 | **Prompt-injected drain**: show the poisoned listing, then the BLOCK; open the row's check trace | "Now the agent reads a poisoned listing and tries to send five thousand dollars to an unknown wallet. Blocked on the cap, the budget, the recipient and the intent. PayPal was never called." |
| 1:30–1:55 | **Gift-card cash-out**, open the trace: every rule green, intent red | "This one is the reason for the AI layer. Right merchant, under every limit. Every number passes. The intent check sees it is not groceries." |
| 1:55–2:15 | **Off-mandate purchase** → review queue → Deny | "When it is unclear, Sentra does not guess. It holds the payment for a human." |
| 2:15–2:40 | **Double-spend race**, then **Velocity burst**; the frozen banner appears; click Reinstate | "Six payments at once cannot beat the budget check, and after repeated blocks the circuit breaker freezes the agent until a human lets it back in." |
| 2:40–2:55 | Ledger chip "intact", a row's hash; then the README attack table | "Every decision is in a hash-chained ledger, and every attack here is a test in the repo. Sentra: allow the good, stop the rest, before the money leaves." |

Rules: no third-party logos or music. If the Claude key is not set, say "intent
check", not "the model". Two or three takes, pick one.
