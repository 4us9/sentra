#!/usr/bin/env node
// Sentra as an MCP server (stdio, JSON-RPC by hand).
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
//   { "command": "npx", "args": ["-y", "@sentra/mcp"],
//     "env": { "SENTRA_URL": "http://localhost:3000", "SENTRA_AGENT_TOKEN": "sat_..." } }
import readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Sentra, type Decision, type Mandate, type PaymentRequest } from '@sentra/sdk';

export const SERVER_VERSION = '0.4.0';

/** The slice of the SDK the server needs; tests pass a stub. */
export type SentraClient = {
  guard(payment: PaymentRequest): Promise<Decision>;
  mandate(): Promise<Mandate>;
};

export const TOOLS = [
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

/** Build the client from the environment. A missing token is reported per tool call, not at startup. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): SentraClient {
  let client: Sentra | undefined;
  const get = () => (client ??= new Sentra({
    url: env.SENTRA_URL || 'http://localhost:3000',
    agentToken: env.SENTRA_AGENT_TOKEN || '',
    timeoutMs: 45_000,
  }));
  return { guard: (p) => get().guard(p), mandate: () => get().mandate() };
}

/** @param args the tool arguments exactly as the model sent them; Sentra validates them */
async function runTool(client: SentraClient, name: unknown, args: unknown = {}): Promise<unknown> {
  if (name === 'mandate') {
    const m = await client.mandate();
    return {
      description: m.description, currency: m.currency, status: m.status, frozenReason: m.frozenReason,
      remaining: Math.round((m.budgetTotal - m.spent) * 100) / 100, budgetTotal: m.budgetTotal,
      perPaymentCap: m.perTxCap, allowedRecipients: m.allowedRecipients, expiresAt: m.expiresAt,
    };
  }
  if (name === 'pay') {
    const d = await client.guard(args as PaymentRequest);
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
  throw new Error(`unknown tool ${String(name)}`);
}

export type JsonRpcMessage = { id?: unknown; method?: unknown; params?: any };
export type JsonRpcReply = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } };

const errText = (e: unknown) => String((e as { message?: unknown })?.message || e);

/** One JSON-RPC message from the client, parsed but not otherwise trusted. Returns the reply, or undefined for notifications. */
export async function handle(msg: JsonRpcMessage, client: SentraClient): Promise<JsonRpcReply | undefined> {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return undefined;      // notification: nothing to answer
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sentra', version: SERVER_VERSION },
        instructions: 'Payments go through the Sentra firewall. Call `mandate` to see what you are allowed to spend, then `pay`.',
      } };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      try {
        const out = await runTool(client, params?.name, params?.arguments);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errText(e) }], isError: true } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: errText(e) } };
  }
}

const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

export function serveStdio(client: SentraClient = clientFromEnv()): void {
  const rl = readline.createInterface({ input: process.stdin });
  let pending: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    pending = pending.then(async () => {
      const r = await handle(msg, client);
      if (r) write(r);
    });
  });
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (isMain()) serveStdio();
