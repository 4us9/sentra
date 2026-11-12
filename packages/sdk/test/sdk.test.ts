import { describe, expect, it, vi } from 'vitest';
import { Sentra, SentraError, PaymentRefused, type Decision } from '../src/index.js';

const decision = (verdict: string, extra: Partial<Decision> = {}): Decision =>
  ({ id: 'd1', verdict, reasons: [], paymentId: null, ...extra }) as unknown as Decision;

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}
const pay = { amount: 5, recipient: 'merchant_x', purpose: 'test' };

describe('Sentra SDK', () => {
  it('requires an agentToken', () => {
    expect(() => new Sentra({} as never)).toThrow(SentraError);
    expect(() => new Sentra(undefined as never)).toThrow('agentToken is required');
  });

  it('trims trailing slashes, sends bearer token and JSON body', async () => {
    const f = fakeFetch(200, decision('ALLOW'));
    const s = new Sentra({ url: 'http://x.test///', agentToken: 'sat_1', fetch: f as unknown as typeof fetch });
    await s.guard(pay);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://x.test/guard');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sat_1');
    expect(JSON.parse(init!.body as string)).toEqual(pay);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('guard returns BLOCK and ALLOW decisions without throwing', async () => {
    for (const v of ['ALLOW', 'BLOCK', 'REVIEW']) {
      const s = new Sentra({ agentToken: 't', fetch: fakeFetch(200, decision(v)) as unknown as typeof fetch });
      expect((await s.guard(pay)).verdict).toBe(v);
    }
  });

  it('guardOrThrow throws PaymentRefused with decision and reason', async () => {
    const d = decision('BLOCK', { reasons: [{ layer: 'rule', check: 'cap', result: 'FAIL', detail: 'over cap' }] });
    const s = new Sentra({ agentToken: 't', fetch: fakeFetch(200, d) as unknown as typeof fetch });
    const err = await s.guardOrThrow(pay).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentRefused);
    expect(err.message).toBe('payment BLOCK: cap: over cap');
    expect(err.decision.verdict).toBe('BLOCK');
    expect(err.verdict).toBe('BLOCK');
  });

  it('guardOrThrow resolves on ALLOW', async () => {
    const s = new Sentra({ agentToken: 't', fetch: fakeFetch(200, decision('ALLOW')) as unknown as typeof fetch });
    expect((await s.guardOrThrow(pay)).verdict).toBe('ALLOW');
  });

  it('non-2xx throws SentraError with status and server message', async () => {
    const s = new Sentra({ agentToken: 't', fetch: fakeFetch(401, { error: 'bad token' }) as unknown as typeof fetch });
    const err = await s.guard(pay).catch((e) => e);
    expect(err).toBeInstanceOf(SentraError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('bad token');
  });

  it('non-JSON error body falls back to a status message', async () => {
    const f = vi.fn(async () => new Response('oops', { status: 502 }));
    const s = new Sentra({ agentToken: 't', fetch: f as unknown as typeof fetch });
    const err = await s.mandate().catch((e) => e);
    expect(err.message).toBe('Sentra returned 502');
    expect(err.status).toBe(502);
  });

  it('mandate() GETs /guard/mandate without a body', async () => {
    const f = fakeFetch(200, { id: 'm1' });
    const s = new Sentra({ agentToken: 't', fetch: f as unknown as typeof fetch });
    expect((await s.mandate()).id).toBe('m1');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/guard/mandate');
    expect(init!.method).toBe('GET');
    expect(init!.body).toBeUndefined();
  });

  it('protect() runs the wrapped fn only on ALLOW', async () => {
    const fn = vi.fn(async (_p: unknown, _d: unknown) => 'paid');
    const allow = new Sentra({ agentToken: 't', fetch: fakeFetch(200, decision('ALLOW')) as unknown as typeof fetch });
    expect(await allow.protect(fn)(pay)).toBe('paid');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![1]).toMatchObject({ verdict: 'ALLOW' });

    fn.mockClear();
    for (const v of ['BLOCK', 'REVIEW', 'ERROR']) {
      const s = new Sentra({ agentToken: 't', fetch: fakeFetch(200, decision(v)) as unknown as typeof fetch });
      await expect(s.protect(fn)(pay)).rejects.toBeInstanceOf(PaymentRefused);
    }
    expect(fn).not.toHaveBeenCalled();
  });
});
