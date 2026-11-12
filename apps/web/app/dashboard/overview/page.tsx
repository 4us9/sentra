'use client';
import Link from 'next/link';
import { ArrowRight, Brain, Gauge, Lock, ScanSearch } from 'lucide-react';
import { PageHeader } from '@/components/app/shell';
import { ProcessorTag, VerdictBadge } from '@/components/app/badges';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clock, decidingText, isNum, layerName, money, procShort, str, CORE_LAYERS } from '@/lib/format';
import { useSentra } from '@/lib/store';
import { cn } from '@/lib/utils';

const LAYER_META = {
  schema: { icon: ScanSearch, hint: 'well-formed?', bar: 'bg-[#7aa2ff]' },
  rule: { icon: Lock, hint: 'caps, budget, allowlist', bar: 'bg-[#f5b942]' },
  anomaly: { icon: Gauge, hint: 'spikes, drains', bar: 'bg-[#ff9d5c]' },
  intent: { icon: Brain, hint: 'signatures + AI', bar: 'bg-[#c79bff]' },
} as const;

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-faint">{label}</p>
      <p className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', tone)}>{value}</p>
      {sub ? <p className="mt-0.5 text-[12px] text-muted">{sub}</p> : null}
    </div>
  );
}

export default function Overview() {
  const { state } = useSentra();
  if (!state) return null;
  const m = state.metrics;
  const n = (v: unknown) => (isNum(v) ? v : 0);
  const bv = m.byVerdict ?? { ALLOW: 0, BLOCK: 0, REVIEW: 0, ERROR: 0 };
  const by = m.stoppedByLayer ?? {};
  const total = Object.values(by).reduce<number>((a, v) => a + n(v), 0);
  const other = Object.entries(by).filter(([k]) => !(CORE_LAYERS as readonly string[]).includes(k)).reduce((a, [, v]) => a + n(v), 0);
  const procs = state.config.processors ?? [];
  const spend = m.spendByProcessor ?? {};
  const names = [...new Set([...procs.map((p) => p.name), ...Object.keys(spend)])].slice(0, 6);
  const recent = state.decisions.filter((d) => d.kind === 'payment').slice(-8).reverse();
  const rate = n(m.blockRate) * 100;

  return (
    <>
      <PageHeader title="Overview" sub="Every payment an agent attempts, and what stopped it." />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {procs.map((p) => <ProcessorTag key={p.name} name={p.name} processors={procs} />)}
        <Badge tone={state.config.intent === 'llm' ? 'accent' : 'neutral'} title="The model only classifies; fixed policy decides.">
          intent: {state.config.intent === 'llm' ? `Claude${state.config.intentModel ? ' · ' + str(state.config.intentModel, 48) : ''}` : 'signatures + fallback'}
        </Badge>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6" aria-label="Metrics">
        <Stat label="Allowed" value={n(bv.ALLOW)} tone="text-allow" sub={n(bv.ERROR) ? `${n(bv.ERROR)} processor errors` : undefined} />
        <Stat label="Blocked" value={n(bv.BLOCK)} tone="text-block" />
        <Stat label="Held for review" value={n(bv.REVIEW)} tone="text-review" sub={n(m.reviewsPending) ? `${n(m.reviewsPending)} pending` : undefined} />
        <Stat label="Block rate" value={`${rate % 1 ? rate.toFixed(1) : rate}%`} sub={`${n(m.decisions)} decisions`} />
        <Stat label="Value blocked" value={money(n(m.blockedValue), 'USD')} tone="text-block" sub="well-formed attempts" />
        <Stat label="Latency p50 / p95" value={n(m.latencyMs?.samples) ? `${Math.round(n(m.latencyMs.p50))} / ${Math.round(n(m.latencyMs.p95))}` : '-'} sub="ms, request to verdict" />
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Four layers, strictest wins</CardTitle>
            <CardDescription>Payments flow left to right and the first layer to refuse decides. Counts are payments each layer stopped.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
              {CORE_LAYERS.map((k, i) => {
                const M = LAYER_META[k]; const c = n(by[k]);
                return (
                  <div key={k} className="flex flex-1 items-center gap-2">
                    <div className={cn('flex-1 rounded-md border p-3', c ? 'border-block/40 bg-block/[0.05]' : 'border-line bg-background/40')}>
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint"><M.icon className="size-3.5" /> Layer {i}</div>
                      <p className="mt-1 text-[14px] font-medium">{layerName(k)}</p>
                      <p className="text-[11px] text-faint">{M.hint}</p>
                      <p className={cn('mt-2 font-mono text-[13px]', c ? 'text-block' : 'text-muted')}>{c} stopped</p>
                    </div>
                    {i < 3 ? <ArrowRight className="hidden size-4 shrink-0 text-faint md:block" /> : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">
              <span className="font-mono text-allow">ALLOW</span><ArrowRight className="size-3" />
              {procs.length ? procs.map((p) => procShort(str(p.label || p.name, 30))).join(' · ') : 'PayPal · Stripe'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stopped by layer</CardTitle>
            <CardDescription>{total ? `${total} stopped` : 'Nothing stopped yet.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className={cn('flex h-3 overflow-hidden rounded-full ring-1 ring-line', !total && 'bg-surface-2')} role="img" aria-label="Stopped by layer">
              {CORE_LAYERS.map((k) => n(by[k]) ? <span key={k} className={LAYER_META[k].bar} style={{ flexGrow: n(by[k]) }} title={`${layerName(k)}: ${n(by[k])}`} /> : null)}
              {other ? <span className="bg-faint" style={{ flexGrow: other }} title={`Human / processor: ${other}`} /> : null}
            </div>
            <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              {CORE_LAYERS.map((k) => <li key={k} className="flex items-center gap-2"><i className={cn('size-2.5 rounded-sm', LAYER_META[k].bar)} /><span className="text-muted">{layerName(k)}</span><b className="ml-auto font-mono">{n(by[k])}</b></li>)}
              {other ? <li className="flex items-center gap-2"><i className="size-2.5 rounded-sm bg-faint" /><span className="text-muted">Human / processor</span><b className="ml-auto font-mono">{other}</b></li> : null}
            </ul>
            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-2 text-[11px] uppercase tracking-wider text-faint">Allowed spend by processor</p>
              <ul className="space-y-1.5 text-[13px]">
                {names.map((k) => <li key={k} className="flex items-center justify-between"><ProcessorTag name={k} processors={procs} withMode={false} /><span className="font-mono tabular-nums">{money(n(spend[k]), 'USD')}</span></li>)}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader className="flex-row items-center justify-between">
          <div><CardTitle>Latest payments</CardTitle></div>
          <Link href="/dashboard/ledger" className="text-xs text-accent hover:underline">Full ledger</Link>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {recent.length ? (
            <ul className="divide-y divide-line/70">
              {recent.map((d) => (
                <li key={d.id}>
                  <Link href={`/dashboard/ledger/${encodeURIComponent(d.id)}`} className="grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-1 px-5 py-2.5 text-[13px] hover:bg-surface-2/60 md:grid-cols-[48px_70px_90px_1fr_auto]">
                    <span className="font-mono text-faint">#{d.seq}</span>
                    <VerdictBadge verdict={d.verdict} />
                    <span className="font-mono tabular-nums">{money(d.request?.amount, d.request?.currency)}</span>
                    <span className="col-span-3 truncate text-muted md:col-span-1">{str(d.request?.recipient, 80)} · {decidingText(d)}</span>
                    <span className="hidden font-mono text-faint md:block">{clock(d.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-muted">No payments yet. <Link href="/dashboard/lab" className="text-accent hover:underline">Run the Attack Lab</Link> to generate some.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
