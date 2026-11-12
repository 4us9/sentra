'use client';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { VerdictBadge, ProcessorTag } from './badges';
import { Trace } from './trace';
import { Badge } from '@/components/ui/badge';
import { dateTime, decidingText, money, nonAscii, shortHash, str } from '@/lib/format';
import { useSentra } from '@/lib/store';
import type { Decision } from '@/lib/types';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 border-b border-line/60 py-2 text-[13px] last:border-0">
      <dt className="text-faint">{k}</dt><dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** Full detail of one ledger entry. All agent-supplied strings are plain text children. */
export function DecisionDetail({ d, linkOut }: { d: Decision; linkOut?: boolean }) {
  const { state, decisionById } = useSentra();
  const rq = d.request ?? { amount: '', currency: '', recipient: '', purpose: '' };
  const resolver = state?.decisions.find((x) => x.resolves === d.id);
  const resolved = d.resolves ? decisionById(d.resolves) : undefined;
  const odd = nonAscii(str(rq.recipient, 200));
  const idx = state?.decisions.findIndex((x) => x.id === d.id) ?? -1;
  const prev = idx > 0 ? state?.decisions[idx - 1] : undefined;
  const linked = prev ? prev.hash === d.prevHash : idx === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-faint">#{d.seq}</span>
        <VerdictBadge verdict={d.verdict} />
        <Badge>{str(d.kind, 24)}</Badge>
        <ProcessorTag name={d.processor} processors={state?.config.processors} withMode={false} />
        {d.replayed ? <Badge tone="accent">replayed</Badge> : null}
        {linkOut ? <Link href={`/dashboard/ledger/${encodeURIComponent(d.id)}`} className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline">Open page <ArrowUpRight className="size-3" /></Link> : null}
      </div>

      {d.verdict !== 'ALLOW' && d.kind === 'payment' ? (
        <p className="rounded-md border border-line bg-background/50 px-3 py-2 text-[13px] leading-relaxed text-muted">{decidingText(d)}</p>
      ) : null}

      <details className="border border-line p-3"><summary className="cursor-pointer font-medium">Decision JSON</summary>
        <pre className="mt-2 overflow-auto font-mono text-xs"><code>{JSON.stringify(d, null, 2)}</code></pre>
      </details>
      <dl>
        <Row k="Amount"><span className="font-mono">{money(rq.amount, rq.currency)}</span></Row>
        <Row k="Recipient"><span className="font-mono">{str(rq.recipient, 200)}</span>
          {odd.length ? <span className="mt-1 block text-xs text-block">Non-ASCII characters: {odd.join('; ')}</span> : null}</Row>
        <Row k="Purpose"><span className="whitespace-pre-wrap">{str(rq.purpose, 600)}</span></Row>
        <Row k="Mandate"><Link className="font-mono text-accent hover:underline" href={`/dashboard/mandates/${encodeURIComponent(d.mandateId)}`}>{str(d.mandateId, 60)}</Link></Row>
        <Row k="Time">{dateTime(d.createdAt)}{typeof d.latencyMs === 'number' ? <span className="ml-2 text-faint">{Math.round(d.latencyMs)} ms</span> : null}</Row>
        <Row k="Payment id">{d.paymentId ? <span className="font-mono">{str(d.paymentId, 80)}</span> : <span className="text-faint">none (processor not called)</span>}</Row>
        <Row k="Intent source">{str(d.intentSource, 20) || '-'}<span className="ml-2 text-faint">risk {String(d.riskScore ?? 0)}</span></Row>
        {rq.idempotencyKey ? <Row k="Idempotency"><span className="font-mono">{str(rq.idempotencyKey, 100)}</span></Row> : null}
        {resolved ? <Row k="Resolves"><Link className="font-mono text-accent hover:underline" href={`/dashboard/ledger/${encodeURIComponent(resolved.id)}`}>#{resolved.seq}</Link></Row> : null}
        {resolver ? <Row k="Resolved by"><Link className="font-mono text-accent hover:underline" href={`/dashboard/ledger/${encodeURIComponent(resolver.id)}`}>#{resolver.seq} {resolver.verdict}</Link></Row> : null}
        {d.effects?.length ? <Row k="Effects">{d.effects.map((e) => <Badge key={e} tone="review" className="mr-1">{str(e, 40)}</Badge>)}</Row> : null}
      </dl>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold">Check trace</h3>
        <Trace reasons={d.reasons} decidedBy={d.decidedBy} />
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">Hash chain {idx >= 0 ? <Badge tone={linked ? 'allow' : 'block'}>{linked ? 'linked to #' + (d.seq - 1) : 'link mismatch'}</Badge> : null}</h3>
        <dl className="rounded-md border border-line bg-background/50 px-3 py-1">
          <Row k="prev hash"><span className="font-mono text-xs">{shortHash(d.prevHash)}</span></Row>
          <Row k="hash"><span className="font-mono text-xs">{shortHash(d.hash)}</span></Row>
        </dl>
      </section>
    </div>
  );
}
