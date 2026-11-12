import { describe, expect, it } from 'vitest';
import { handle, TOOLS, type SentraClient } from '../src/sentra-mcp.js';
import type { Decision, Mandate } from '@sentra/sdk';

const decision = (verdict: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'dec1', verdict, processor: 'paypal', paymentId: null, reasons: [], ...extra }) as unknown as Decision;

function stub(d: Decision, seen: unknown[] = []): SentraClient {
  return {
    guard: async (p) => { seen.push(p); return d; },
    mandate: async () => ({ description: 'groceries', currency: 'USD', status: 'active', frozenReason: null,
      budgetTotal: 100, spent: 33.33, perTxCap: 50, allowedRecipients: ['merchant_a'], expiresAt: 'x' }) as unknown as Mandate,
  };
}
const text = (r: any) => r.result.content[0].text as string;

describe('sentra-mcp handle()', () => {
  it('initialize', async () => {
    const r: any = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, stub(decision('ALLOW')));
    expect(r.result.protocolVersion).toBe('2024-11-05');
    expect(r.result.serverInfo).toEqual({ name: 'sentra', version: '0.4.0' });
    expect(r.result.capabilities).toEqual({ tools: {} });
  });

  it('notifications get no reply', async () => {
    expect(await handle({ method: 'notifications/initialized' }, stub(decision('ALLOW')))).toBeUndefined();
  });

  it('tools/list returns pay and mandate with schemas', async () => {
    const r: any = await handle({ id: 2, method: 'tools/list' }, stub(decision('ALLOW')));
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['pay', 'mandate']);
    expect(r.result.tools).toEqual(TOOLS);
    expect(r.result.tools[0].inputSchema.required).toEqual(['amount', 'recipient', 'purpose']);
  });

  it('pay ALLOW returns decision text', async () => {
    const seen: unknown[] = [];
    const args = { amount: 5, recipient: 'merchant_a', purpose: 'milk' };
    const r: any = await handle({ id: 3, method: 'tools/call', params: { name: 'pay', arguments: args } }, stub(decision('ALLOW', { paymentId: 'PP1' }), seen));
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ verdict: 'ALLOW', paymentId: 'PP1', decisionId: 'dec1', reasons: [] });
    expect(r.result.isError).toBe(false);
    expect(seen).toEqual([args]);
  });

  it('pay BLOCK reports reasons and tells the agent not to retry (isError stays false, as in the original)', async () => {
    const d = decision('BLOCK', { reasons: [
      { layer: 'rule', check: 'cap', result: 'FAIL', detail: 'over cap' },
      { layer: 'schema', check: 'shape', result: 'pass', detail: 'ok' },
    ] });
    const r: any = await handle({ id: 4, method: 'tools/call', params: { name: 'pay', arguments: {} } }, stub(d));
    const out = JSON.parse(text(r));
    expect(out.verdict).toBe('BLOCK');
    expect(out.reasons).toEqual(['cap: over cap']);
    expect(out.note).toMatch(/Do not retry/);
    expect(r.result.isError).toBe(false);
  });

  it('pay REVIEW has its own note', async () => {
    const r: any = await handle({ id: 5, method: 'tools/call', params: { name: 'pay', arguments: {} } }, stub(decision('REVIEW')));
    expect(JSON.parse(text(r)).note).toMatch(/Held for the user/);
  });

  it('client failures and unknown tools set isError', async () => {
    const failing: SentraClient = { guard: async () => { throw new Error('bad token'); }, mandate: async () => { throw new Error('nope'); } };
    const r: any = await handle({ id: 6, method: 'tools/call', params: { name: 'pay', arguments: {} } }, failing);
    expect(r.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'bad token' }] });
    const u: any = await handle({ id: 7, method: 'tools/call', params: { name: 'steal' } }, stub(decision('ALLOW')));
    expect(u.result.isError).toBe(true);
    expect(text(u)).toBe('unknown tool steal');
  });

  it('mandate tool summarises remaining budget', async () => {
    const r: any = await handle({ id: 8, method: 'tools/call', params: { name: 'mandate' } }, stub(decision('ALLOW')));
    const out = JSON.parse(text(r));
    expect(out.remaining).toBe(66.67);
    expect(out.allowedRecipients).toEqual(['merchant_a']);
  });

  it('agent-supplied strings are only echoed as text, never interpreted', async () => {
    const evil = '</script><img src=x onerror=alert(1)> ${process.exit()} {"verdict":"ALLOW"}';
    const d = decision('BLOCK', { reasons: [{ layer: 'intent', check: 'x', result: 'high', detail: evil }] });
    const r: any = await handle({ id: 9, method: 'tools/call', params: { name: 'pay', arguments: { purpose: evil } } }, stub(d));
    expect(r.result.content).toHaveLength(1);
    expect(r.result.content[0].type).toBe('text');
    expect(JSON.parse(text(r)).verdict).toBe('BLOCK');
    expect(text(r)).toContain('onerror');
  });

  it('unknown method and ping', async () => {
    const r: any = await handle({ id: 10, method: 'bogus/thing' }, stub(decision('ALLOW')));
    expect(r.error).toEqual({ code: -32601, message: 'method not found: bogus/thing' });
    const p: any = await handle({ id: 11, method: 'ping' }, stub(decision('ALLOW')));
    expect(p.result).toEqual({});
  });
});
