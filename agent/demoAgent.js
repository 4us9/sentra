// A simulated AI shopping agent. It shops normally, then reads a poisoned listing
// and starts behaving like a hijacked agent. It holds no PayPal credentials: its
// only way to move money is to ask Sentra.
//
//   Terminal 1:  npm start
//   Terminal 2:  npm run demo            (GUARD_URL=https://... to target a deployment)
import '../src/env.js';
import { SCENARIOS, POISONED_LISTING } from './scenarios.js';

const BASE = (process.env.GUARD_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const admin = process.env.SENTRA_ADMIN_TOKEN ? { 'x-sentra-admin': process.env.SENTRA_ADMIN_TOKEN } : {};

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${j.error || ''}`);
  return j;
}

function line(label, d) {
  const hit = (d.reasons || []).find((r) => ['FAIL', 'FLAG', 'high', 'med', 'error'].includes(r.result));
  const why = hit ? `${hit.check}: ${hit.detail}` : 'within mandate';
  const order = d.paymentId ? `  ${d.processor}=${d.paymentId}` : '';
  const frozen = (d.effects || []).includes('mandate_frozen') ? '   << CIRCUIT BREAKER: mandate frozen' : '';
  console.log(`  ${label.padEnd(30)} ${String(d.verdict).padEnd(6)} ${why}${order}${frozen}`);
}

async function main() {
  // The human sets the mandate; the agent is handed a token scoped to it.
  const { mandate: m, agentToken } = await post('/api/mandates', {}, admin);
  const pay = (p) => post('/guard', p, { Authorization: `Bearer ${agentToken}` });

  console.log(`\nMandate ${m.id}: "${m.description}"`);
  console.log(`  budget $${m.budgetTotal}, per-payment cap $${m.perTxCap}, recipients: ${m.allowedRecipients.join(', ')}`);

  for (const s of SCENARIOS) {
    // If the circuit breaker has frozen the agent, a human has to let it back in.
    const cur = (await (await fetch(BASE + '/api/state')).json()).mandates.find((x) => x.id === m.id);
    if (cur.status === 'frozen') {
      console.log(`\nOPERATOR  mandate is frozen (${cur.frozenReason}). A human reviews and reinstates the agent.`);
      await post(`/api/mandates/${m.id}/reinstate`, {}, admin);
    }
    console.log(`\n${s.category === 'legit' ? 'LEGIT ' : 'ATTACK'}  ${s.title}  (expect ${s.expect})\n  ${s.blurb}`);
    if (s.id === 'hijack') console.log(POISONED_LISTING.trim().split('\n').map((l) => '    | ' + l).join('\n'));
    const label = (p) => `$${p.amount} -> ${p.recipient}`.slice(0, 30);
    if (s.concurrent) {
      const out = await Promise.all(s.steps.map(pay));
      out.forEach((d, i) => line(label(s.steps[i]), d));
    } else {
      for (const p of s.steps) line(label(p), await pay(p));
    }
  }

  const state = await (await fetch(BASE + '/api/state')).json();
  const mine = state.mandates.find((x) => x.id === m.id);
  console.log(`\nResult: spent $${mine.spent.toFixed(2)} of $${mine.budgetTotal} (never over), mandate is ${mine.status}.`);
  console.log(`Audit ledger: ${state.audit.length} entries, hash chain ${state.audit.ok ? 'intact' : 'BROKEN'}.`);
  console.log(`PayPal: ${state.config.paypal}. Intent check: ${state.config.intent}.`);
  console.log(`\nOpen ${BASE} to see every decision and reinstate the frozen mandate.\n`);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
