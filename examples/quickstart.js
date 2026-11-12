// Runnable end to end against a local Sentra:
//
//   npm start                      (terminal 1)
//   node examples/quickstart.js    (terminal 2)
//
// Step 1 is the human (operator) side: issue a mandate from a policy file.
// Step 2 is all an agent ever needs: three lines.
import { Sentra } from '../sdk/index.js';

const url = process.env.SENTRA_URL || 'http://localhost:3000';

// 1. Operator: issue a mandate. The agent token comes back once; hand it to the agent.
const issued = await fetch(`${url}/api/mandates`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ policy: 'grocery-run', processor: process.env.SENTRA_PROCESSOR || 'paypal' }),
}).then((r) => r.json());

// 2. Agent: guard every payment.
const sentra = new Sentra({ url, agentToken: issued.agentToken });
const decision = await sentra.guard({ amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' });
if (decision.verdict === 'ALLOW') console.log(`paid via ${decision.processor}: ${decision.paymentId}`);

// The same call when the agent has been hijacked:
const hijacked = await sentra.guard({ amount: 5000, recipient: 'wallet_unknown_0xABCD', purpose: 'urgent transfer' });
console.log(`${hijacked.verdict}: stopped by ${hijacked.decidedBy.layer}/${hijacked.decidedBy.check}`);
