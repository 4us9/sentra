# Demo video — shot list (under 3:00, public on YouTube)

1080p screen recording with voiceover. Before recording: `pnpm start`, open the
dashboard, **Reset demo**. The header should read PayPal SANDBOX and Intent
Claude. Every beat below is one click; write nothing on camera.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:20 | Title card: *Sentra — the firewall between AI agents and the money* | "AI agents are starting to spend money. Anything an agent reads can tell it what to do, and to the payment processor a hijacked agent looks exactly like a healthy one. Payment failures today are often not break-ins at all: they are code doing what it was told. Nothing sits between an agent's decision and the money. Sentra does." |
| 0:20–0:40 | Issue mandate: policy *grocery-run*, processor **PayPal**. Mandate panel. | "A human sets the mandate: three hundred dollars, groceries, seventy-five per payment, two merchants. It is a policy file, sealed when issued. The agent never gets PayPal credentials. It gets one tool, pay, and a token for this mandate only." |
| 0:40–0:58 | Attack Lab → **Weekly groceries**. Order ids appear in the ledger. | "Normal shopping goes straight through. These are real PayPal sandbox orders." |
| 0:58–1:22 | **Prompt-injected drain**: the poisoned listing, then BLOCK. Open the row's trace. | "Now the agent reads a poisoned listing and tries to send five thousand dollars to an unknown wallet. Blocked on the cap, the budget, the recipient and the intent. PayPal was never called." |
| 1:22–1:45 | **Gift-card cash-out** → BLOCK; trace shows every rule green, intent red. Then **Off-mandate purchase** → REVIEW with Claude's sentence on the card; Deny it in the review queue. | "This is why there is an AI layer. Right merchant, under every limit, every number passes. Intent catches it. And when a purchase is merely off-purpose, Claude says why and Sentra holds it for a human. The model only classifies. It can never approve what a rule refused." |
| 1:45–2:08 | **Double-spend race**, then **Velocity burst**; the frozen banner; click **Reinstate**. | "Three payments at the same instant: one fits, the others see its reservation. After repeated blocks the circuit breaker freezes the agent until a human lets it back in." |
| 2:08–2:28 | Issue a second mandate, processor **Stripe**. Run the hijack and the gift card. Filter the ledger by processor. | "Same policy, same attacks, different rail. The engine does not know which processor is behind it. PayPal, Stripe, or your own." |
| 2:28–2:45 | Terminal: `pnpm test` (the adversarial lines scrolling, all passing), then `pnpm verify-ledger`. | "Ninety-three attack payloads run on every commit, and none may ever be allowed, even with the reviewer model fully compromised. Every decision is in a hash-chained ledger you can verify offline." |
| 2:45–2:58 | README integration section, then the dashboard. | "Three lines with the SDK, or drop it in as an MCP server. Sentra: allow the good, stop the rest, before the money leaves." |

Rules: no third-party logos or music. If the Claude key is not set, say "intent
check", not "Claude". If Stripe shows SIMULATED, say "simulated Stripe" or cut
the Stripe id close-up. Never say the money "moved": a PayPal ALLOW is a created
sandbox order. Two or three takes, pick one.
