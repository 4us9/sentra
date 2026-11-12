# Adding a payment processor

The policy engine never sees a processor. Adding a rail means writing one small
adapter and registering it; no rule, test corpus or dashboard code changes.

## 1. Write the adapter

`src/processors/<name>.js`, exporting an object that satisfies `PaymentProcessor`
(typedef in `src/processors/index.js`):

```js
/** @type {import('./index.js').PaymentProcessor} */
export const acme = {
  name: 'acme',
  label: 'Acme Pay',
  // 'sandbox' or 'test' when credentials are present, otherwise 'simulated'.
  mode: () => (process.env.ACME_TEST_KEY ? 'test' : 'simulated'),

  async createPayment({ amount, currency, recipient, purpose, idempotencyKey }) {
    // 1. call the processor, passing idempotencyKey as ITS idempotency key
    // 2. read back amount and currency; throw if they differ from what was approved
    // 3. return { processor: 'acme', id, status, mode: 'test', verified: true }
  },
};
```

## 2. Keep the contract

These are not style points; the guard relies on each of them.

| Rule | Why |
|---|---|
| **Refuse live credentials at load.** Throw if the key or base URL is not a sandbox/test one. | Sentra must be incapable of moving real money by misconfiguration. |
| **Idempotent on `idempotencyKey`.** It is the Sentra decision id. | A retry after a timeout must not create a second payment. |
| **Read back and compare.** Amount in minor units and currency must equal what was approved, or throw. | "What was created is what was approved" is checked, not assumed. |
| **Throw on any failure.** Never return a partial result. | The guard turns a throw into `ERROR` and releases the reservation; nothing is debited. |
| **No secrets in error messages.** | Error text is stored in the ledger. It is scrubbed for known key shapes, but do not rely on that. |
| **A timeout on every call.** | The reservation is held until the call settles. |
| **Minor units are the adapter's job.** | Zero-decimal currencies differ per processor; see `minorUnits` in `stripe.js`. |

Do not implement simulation yourself. `withSimulation` in `index.js` wraps every
adapter: when `mode()` is `'simulated'`, or `SENTRA_PROCESSOR_MODE=simulate`, the
adapter is not called and a `SIM-<NAME>-…` result is returned.

## 3. Register it

```js
// src/processors/index.js
import { acme } from './acme.js';
const REGISTRY = { paypal, stripe, external, acme };
```

Add the name to the `processor` enum in `policies/policy.schema.json`, and its
variables to `.env.example` and `render.yaml`.

## 4. Check it

```bash
npm test
```

```bash
npm run typecheck
```

```bash
DEMO_PROCESSORS=paypal,acme npm run demo
```

The demo prints whether verdicts are identical across the rails. They must be:
if a verdict differs by processor, something in the engine has started to depend
on the rail, which invariant 4 in `CLAUDE.md` forbids.

Then run it once against the processor's real sandbox and record the result in
`STATUS.md`. Until that has happened, list the adapter there as unverified.
