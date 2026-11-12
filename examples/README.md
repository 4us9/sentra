# Integrating Sentra

Three ways in. All three end at the same chokepoint (`POST /guard`), the same
policy engine and the same ledger, whichever processor sits behind it.

| Mode | Use it when | The agent holds |
|---|---|---|
| **SDK** | you write the agent's code | a Sentra agent token |
| **Proxy** | the agent already has a payment tool you want to gate | a Sentra agent token (your tool keeps its keys) |
| **MCP** | the agent is an MCP client (Claude Desktop, Claude Code, any MCP host) | a Sentra agent token |

In every mode the first step is the same and belongs to a human, not the agent:
issue a mandate and hand the returned token to the agent.

```bash
curl -s -X POST localhost:3000/api/mandates -H 'Content-Type: application/json' -d '{"policy":"grocery-run","processor":"paypal"}'
```

Use `"processor":"stripe"` for a Stripe mandate. Same policy, same checks, other rail.

## 1. SDK

```js
import { Sentra } from 'sentra/sdk';

const sentra = new Sentra({ url: process.env.SENTRA_URL, agentToken: process.env.SENTRA_AGENT_TOKEN });
const decision = await sentra.guard({ amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' });
if (decision.verdict === 'ALLOW') console.log(decision.paymentId);
```

Types ship in `sdk/index.d.ts`. Runnable version: [quickstart.js](quickstart.js).

`guard()` resolves for every verdict. `guardOrThrow()` rejects with
`PaymentRefused` (carrying the full decision) unless the verdict is `ALLOW`.

## 2. Proxy: wrap a tool the agent already has

```js
const tools = {
  pay_with_paypal:    sentra.protect((payment) => payWithPayPal(payment)),
  charge_with_stripe: sentra.protect((payment) => chargeWithStripe(payment)),
};
```

The wrapped function cannot run unless the firewall allowed that exact payment.
Issue the mandate with `"processor":"external"` for this mode: Sentra then
authorises and records the payment but leaves execution to your tool, so nothing
is paid twice. The ledger marks those payments `mode: external, verified: false`,
because Sentra cannot see what your tool did afterwards.
Runnable version: [protect-existing-tool.js](protect-existing-tool.js).

Without the SDK it is one HTTP call:

```bash
curl -s -X POST localhost:3000/guard -H "Authorization: Bearer $SENTRA_AGENT_TOKEN" -H 'Content-Type: application/json' -d '{"amount":40,"recipient":"merchant_freshmart","purpose":"weekly groceries","idempotencyKey":"order-7781"}'
```

## 3. MCP: replace the agent's payment tools

Remove the PayPal and Stripe MCP servers (or tools) from the agent and add Sentra's.
The agent gets two tools, `pay` and `mandate`, and no processor credentials at all.

```json
{
  "mcpServers": {
    "sentra": {
      "command": "node",
      "args": ["/absolute/path/to/sentra/mcp/sentra-mcp.js"],
      "env": {
        "SENTRA_URL": "http://localhost:3000",
        "SENTRA_AGENT_TOKEN": "sat_..."
      }
    }
  }
}
```

One mandate per rail: issue a PayPal mandate and a Stripe mandate, and register the
server twice (`sentra-paypal`, `sentra-stripe`) with the two tokens if an agent
should be able to use both.

Claude Code:

```bash
claude mcp add sentra --env SENTRA_URL=http://localhost:3000 --env SENTRA_AGENT_TOKEN=sat_... -- node /absolute/path/to/sentra/mcp/sentra-mcp.js
```

## What the agent should do with a verdict

| Verdict | Meaning | Agent behaviour |
|---|---|---|
| `ALLOW` | executed on the processor; `paymentId` is set | continue |
| `REVIEW` | held for a human | tell the user it is waiting; do not retry |
| `BLOCK` | refused; processor never called | report it; do not rephrase and retry |
| `ERROR` | allowed, but the processor failed; nothing debited | safe to retry with the same `idempotencyKey` |

Repeated `BLOCK`s freeze the mandate. That is deliberate: an agent that keeps
probing is treated as compromised until a human reinstates it.
