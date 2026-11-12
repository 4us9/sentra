// A simulated AI shopping agent. It shops normally, then reads a poisoned listing
// and starts behaving like a hijacked agent. It holds no processor credentials: its
// only way to move money is to ask Sentra (through the SDK).
//
// The same mandate and the same attacks are run once per payment rail, to show the
// firewall does not care which processor sits behind it.
//
//   Terminal 1:  npm start
//   Terminal 2:  npm run demo
//
//   GUARD_URL=https://...           target a deployment
//   DEMO_PROCESSORS=paypal          run one rail only (default: paypal,stripe)
import '../src/env.js';
import { Sentra } from '../sdk/index.js';
import { SCENARIOS, POISONED_LISTING } from './scenarios.js';

const BASE = (process.env.GUARD_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const RAILS = (process.env.DEMO_PROCESSORS || 'paypal,stripe').split(',').map((s) => s.trim()).filter(Boolean);
/** @type {Record<string, string>} */
const admin = process.env.SENTRA_ADMIN_TOKEN ? { 'x-sentra-admin': process.env.SENTRA_ADMIN_TOKEN } : {};

/**
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>} the server's JSON answer
 */
async function operator(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...admin }, body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${j.error || ''}`);
  return j;
}
/** @returns {Promise<any>} the dashboard state, as served by GET /api/state */
const state = async () => (await fetch(BASE + '/api/state')).json();

/** @param {string} label @param {import('../sdk/index.js').Decision} d */
function line(label, d) {
  const hit = (d.reasons || []).find((r) => ['FAIL', 'FLAG', 'high', 'med', 'error'].includes(r.result));
  const why = hit ? `${hit.check}: ${hit.detail}` : 'within mandate';
  const paid = d.paymentId ? `  ${d.processor}=${d.paymentId}` : '';
  const frozen = (d.effects || []).includes('mandate_frozen') ? '   << CIRCUIT BREAKER: mandate frozen' : '';
  console.log(`  ${label.padEnd(30)} ${String(d.verdict).padEnd(6)} ${why}${paid}${frozen}`);
}

/** @param {string} processor @returns {Promise<string[]>} */
async function runRail(processor) {
  // The human issues the mandate (from the policy file); the agent is handed a token scoped to it.
  const { mandate: m, agentToken } = await operator('/api/mandates', { policy: 'grocery-run', processor });
  const sentra = new Sentra({ url: BASE, agentToken });

  console.log(`\n${'='.repeat(78)}\nRAIL: ${processor.toUpperCase()}   mandate ${m.id}: "${m.description}"`);
  console.log(`  budget $${m.budgetTotal}, per-payment cap $${m.perTxCap}, recipients: ${m.allowedRecipients.join(', ')}`);

  const verdicts = [];
  for (const s of SCENARIOS) {
    // If the circuit breaker has frozen the agent, a human has to let it back in.
    const cur = (await state()).mandates.find((/** @type {{ id: string }} */ x) => x.id === m.id);
    if (cur.status === 'frozen') {
      console.log(`\nOPERATOR  mandate is frozen (${cur.frozenReason}). A human reviews and reinstates the agent.`);
      await operator(`/api/mandates/${m.id}/reinstate`);
    }
    console.log(`\n${s.category === 'legit' ? 'LEGIT ' : 'ATTACK'}  ${s.title}  (expect ${s.expect})\n  ${s.blurb}`);
    if (s.id === 'hijack') console.log(POISONED_LISTING.trim().split('\n').map((l) => '    | ' + l).join('\n'));
    /** @param {{ amount: number, recipient: string }} p */
    const label = (p) => `$${p.amount} -> ${p.recipient}`.slice(0, 30);
    const out = [];
    if (s.concurrent) out.push(...await Promise.all(s.steps.map((p) => sentra.guard(p))));
    else for (const p of s.steps) out.push(await sentra.guard(p));
    out.forEach((d, i) => line(label(s.steps[i]), d));
    verdicts.push(out.map((d) => d.verdict).sort().join(','));
  }

  const mine = (await state()).mandates.find((/** @type {{ id: string }} */ x) => x.id === m.id);
  console.log(`\n  ${processor}: spent $${mine.spent.toFixed(2)} of $${mine.budgetTotal} (never over), mandate is ${mine.status}.`);
  return verdicts;
}

async function main() {
  /** @type {Record<string, string[]>} */
  const results = {};
  for (const rail of RAILS) results[rail] = await runRail(rail);

  const s = await state();
  console.log(`\n${'='.repeat(78)}`);
  if (RAILS.length > 1) {
    const same = RAILS.every((r) => JSON.stringify(results[r]) === JSON.stringify(results[RAILS[0]]));
    console.log(`Same firewall, any rail: verdicts on ${RAILS.join(' and ')} are ${same ? 'IDENTICAL' : 'DIFFERENT (investigate)'}.`);
  }
  console.log(`Audit ledger: ${s.audit.length} entries, hash chain ${s.audit.ok ? 'intact' : 'BROKEN'}.`);
  console.log(`Processors: ${s.config.processors.map((/** @type {{ label: string, mode: string }} */ p) => `${p.label} ${p.mode}`).join(', ')}. Intent check: ${s.config.intent}.`);
  console.log(`\nOpen ${BASE} to see every decision.\n`);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
