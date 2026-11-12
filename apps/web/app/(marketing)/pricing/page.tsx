import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { GITHUB_URL } from '@/lib/env';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Pricing' };

const OPEN = [
  'All four layers: schema, rules, anomaly, intent',
  'PayPal sandbox, Stripe test mode, and an authorise-only rail',
  'Hash-chained ledger, CSV export, Prometheus metrics',
  'SDK, MCP server, policy files',
  'Operator dashboard (this app)',
  'MIT licensed. Run it anywhere.',
];
const HOSTED = [
  'Managed service with per-tenant API keys',
  'Postgres with row locks, shared reservation and rate-limit state',
  'Per-operator auth and tenant isolation',
  'Webhooks on REVIEW and circuit-breaker trips',
];

export default function Pricing() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-20">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">Pricing</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Open source. Self-host for free.</h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">Sentra is a hackathon project in sandbox and test mode. There is nothing to buy today, and no hosted plan to sign up for.</p>
      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-accent/40 bg-surface p-6">
          <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Self-host</h2><Badge tone="allow">available now</Badge></div>
          <p className="mt-3 font-mono text-4xl font-semibold tracking-tight">$0</p>
          <ul className="mt-5 space-y-2.5">{OPEN.map((x) => <li key={x} className="flex gap-2.5 text-[14px] text-muted"><Check className="mt-0.5 size-4 shrink-0 text-allow" />{x}</li>)}</ul>
          <div className="mt-6 flex gap-2">
            <a href={GITHUB_URL} rel="noreferrer" className={buttonVariants()}>Get the source</a>
            <Link href="/docs" className={buttonVariants({ variant: 'outline' })}>Docs</Link>
          </div>
        </section>
        <section className="rounded-lg border border-line bg-surface p-6">
          <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Hosted</h2><Badge tone="review">coming</Badge></div>
          <p className="mt-3 font-mono text-4xl font-semibold tracking-tight text-faint">TBD</p>
          <p className="mt-2 text-[13px] text-faint">No price has been set and nothing is for sale.</p>
          <ul className="mt-5 space-y-2.5">{HOSTED.map((x) => <li key={x} className="flex gap-2.5 text-[14px] text-muted"><Check className="mt-0.5 size-4 shrink-0 text-faint" />{x}</li>)}</ul>
          <p className={cn('mt-6 text-[13px] text-faint')}>These are on the roadmap, not in the product. Follow the repository for progress.</p>
        </section>
      </div>
    </div>
  );
}
