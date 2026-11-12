#!/usr/bin/env node
// Sentra as an MCP server (stdio, zero dependencies).
//
// Give an AI agent THIS instead of PayPal credentials. The agent gets one way to
// move money, `pay`, and every call goes through the Sentra firewall first. The
// agent never holds a PayPal key, so a hijacked agent has nothing to steal and
// nothing to call directly.
//
//   SENTRA_URL          where Sentra runs (default http://localhost:3000)
//   SENTRA_AGENT_TOKEN  the mandate-scoped token issued when the mandate was created
//
// Example (Claude Desktop / Claude Code mcp config):
//   { "command": "node", "args": ["/abs/path/sentra/mcp/sentra-mcp.js"],
//     "env": { "SENTRA_URL": "http://localhost:3000", "SENTRA_AGENT_TOKEN": "sat_..." } }
import readline from 'node:readline';

const URL_BASE = (process.env.SENTRA_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.SENTRA_AGENT_TOKEN || '';

const TOOLS = [
  {
    name: 'pay',
    description:
      'Request a payment through PayPal on the user\'s behalf. Every request is inspected by the Sentra firewall ' +
      'against the user\'s mandate before any money moves. Returns ALLOW (approved and submitted to PayPal, with an order id), ' +
      'BLOCK (refused, with the reason), or REVIEW (held until the user approves it). ' +
      'A BLOCK is final: do not retry with altered details.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount in the mandate currency, at most 2 decimals.' },
        recipient: { type: 'string', description: 'Recipient id exactly as listed in the mandate.' },
        purpose: { type: 'string', description: 'What this payment is for, in plain words.' },
        idempotencyKey: { type: 'string', description: 'Optional. Reuse the same key when retrying so the payment is only made once.' },
      },
      required: ['amount', 'recipient', 'purpose'],
      additionalProperties: false,
    },
  },
  {
    name: 'mandate',
    description: 'Show what the user has authorised: remaining budget, per-payment cap, allowed recipients, expiry, and whether the mandate is frozen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function call(method, path, body) {
  const r = await fetch(URL_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Sentra returned ${r.status}`);
  return j;
}

async function runTool(name, args = {}) {
  if (name === 'mandate') {
    const m = await call('GET', '/guard/mandate');
    return {
      description: m.description, currency: m.currency, status: m.status, frozenReason: m.frozenReason,
      remaining: Math.round((m.budgetTotal - m.spent) * 100) / 100, budgetTotal: m.budgetTotal,
      perPaymentCap: m.perTxCap, allowedRecipients: m.allowedRecipients, expiresAt: m.expiresAt,
    };
  }
  if (name === 'pay') {
    const d = await call('POST', '/guard', args);
    const why = (d.reasons || []).filter((r) => ['FAIL', 'FLAG', 'high', 'med', 'error'].includes(r.result));
    return {
      verdict: d.verdict,
      processor: d.processor,
      paymentId: d.paymentId,
      decisionId: d.id,
      reasons: why.map((r) => `${r.check}: ${r.detail}`),
      note: d.verdict === 'ALLOW' ? 'Approved by the firewall and submitted to PayPal.'
        : d.verdict === 'REVIEW' ? 'Held for the user to approve. Do not retry; tell the user it is waiting for them.'
          : 'Refused by the payment firewall. Do not retry or rephrase; report this to the user.',
    };
  }
  throw new Error(`unknown tool ${name}`);
}

const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;                 // notification: nothing to answer
  try {
    if (method === 'initialize') {
      return reply({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sentra', version: '0.2.0' },
        instructions: 'Payments go through the Sentra firewall. Call `mandate` to see what you are allowed to spend, then `pay`.',
      } });
    }
    if (method === 'ping') return reply({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const out = await runTool(params?.name, params?.arguments);
        return reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false } });
      } catch (e) {
        return reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
      }
    }
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    reply({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
let pending = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  pending = pending.then(() => handle(msg));
});
