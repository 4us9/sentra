# @sentra/sdk

Client for [Sentra](../../README.md), the firewall between AI agents and payments. Zero runtime dependencies; Node 18+, Bun, Deno and browsers.

```sh
pnpm add @sentra/sdk
```

```ts
import { Sentra, PaymentRefused } from '@sentra/sdk';

const sentra = new Sentra({ url: process.env.SENTRA_URL, agentToken: process.env.SENTRA_AGENT_TOKEN! });

const d = await sentra.guard({ amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' });
if (d.verdict === 'ALLOW') console.log('paid', d.paymentId);

// Throws PaymentRefused (with .decision) unless ALLOW:
await sentra.guardOrThrow({ amount: 40, recipient: 'merchant_freshmart', purpose: 'groceries' });

// Only runs your function after Sentra allows the payment:
const safePay = sentra.protect((payment, decision) => myProcessor.pay(payment));
```

`guard()` resolves with the decision for every verdict (ALLOW, BLOCK, REVIEW, ERROR); it rejects with `SentraError` (carrying `status`) only on transport or auth failure.

## The agent token picks the mandate

There is no mandate argument. The token identifies the one human-issued mandate the agent is judged against, so an agent cannot choose, widen or switch mandates. The agent never holds processor credentials.
