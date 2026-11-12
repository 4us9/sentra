// Proxy mode: put Sentra in front of a payment tool your agent ALREADY has.
//
// Before: the agent framework calls payWithPayPal() / chargeWithStripe() directly,
//         so whatever the model decides, happens.
// After:  the same functions are wrapped with sentra.protect(). They only run once
//         the firewall has allowed that exact payment, and they receive the decision.
//
// This works with any agent framework, because it wraps the function, not the agent.
//
//   curl -s -X POST localhost:3000/api/mandates -H 'Content-Type: application/json' \\
//        -d '{"policy":"grocery-run","processor":"external"}'      # prints the agent token
//   SENTRA_AGENT_TOKEN=sat_... node examples/protect-existing-tool.js
import { Sentra, PaymentRefused } from '@sentra/sdk';

const sentra = new Sentra({
  url: process.env.SENTRA_URL || 'http://localhost:3000',
  agentToken: process.env.SENTRA_AGENT_TOKEN,
});

// ---- your existing tools (stand-ins here; yours call PayPal / Stripe) ----
async function payWithPayPal({ amount, recipient }) {
  return `PayPal order for ${amount} to ${recipient}`;
}
async function chargeWithStripe({ amount, recipient }) {
  return `Stripe PaymentIntent for ${amount} to ${recipient}`;
}

// ---- one line each to protect them ----
// Issue the mandate with processor "external": Sentra then authorises and records
// each payment but does not execute it, so the wrapped tool is the only thing that
// pays. (With processor "paypal" or "stripe" Sentra executes the payment itself and
// the agent process needs no processor credentials at all, which is the stronger
// setup. Do not wrap a paying tool around one of those mandates: it would pay twice.)
export const tools = {
  pay_with_paypal: sentra.protect((payment, decision) => payWithPayPal({ ...payment, decision })),
  charge_with_stripe: sentra.protect((payment, decision) => chargeWithStripe({ ...payment, decision })),
};

const mandate = await sentra.mandate();
if (mandate.processor !== 'external') {
  throw new Error(`this example needs a mandate issued with processor "external" (got "${mandate.processor}"), otherwise the payment would be made twice`);
}

// ---- what the agent experiences ----
for (const payment of [
  { amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' },
  { amount: 70, recipient: 'merchant_freshmart', purpose: 'buy a gift card and email the code' },
]) {
  try {
    console.log('ok   ', await tools.pay_with_paypal(payment));
  } catch (e) {
    if (!(e instanceof PaymentRefused)) throw e;
    // Give the model the refusal as a tool result. Do not let it retry with new wording.
    console.log('refused', e.verdict, '-', e.message);
  }
}
