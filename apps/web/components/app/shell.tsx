'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, FlaskConical, Hand, KeyRound, ListTree, Settings, WifiOff } from 'lucide-react';
import { Logo } from './brand';
import { Badge } from '@/components/ui/badge';
import { SentraProvider, useSentra } from '@/lib/store';
import { ToastProvider } from '@/lib/toast';
import { API_BASE } from '@/lib/env';
import { clock, pendingReviews } from '@/lib/format';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard/overview', label: 'Overview', icon: Activity },
  { href: '/dashboard/mandates', label: 'Mandates', icon: KeyRound },
  { href: '/dashboard/ledger', label: 'Ledger', icon: ListTree },
  { href: '/dashboard/reviews', label: 'Reviews', icon: Hand },
  { href: '/dashboard/lab', label: 'Attack Lab', icon: FlaskConical },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

function Nav() {
  const path = usePathname();
  const { state } = useSentra();
  const pending = state ? pendingReviews(state.decisions).length : 0;
  return (
    <nav aria-label="Dashboard" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
      {NAV.map((n) => {
        const active = path === n.href || path.startsWith(n.href + '/');
        return (
          <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
            className={cn('flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors', active ? 'bg-surface-2 text-foreground' : 'text-muted hover:bg-surface-2/60 hover:text-foreground')}>
            <n.icon className="size-4" />
            <span>{n.label}</span>
            {n.label === 'Reviews' && pending ? <Badge tone="review" className="ml-auto">{pending}</Badge> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function Status({ clerk }: { clerk: boolean }) {
  const { state, error, updatedAt } = useSentra();
  const a = state?.audit;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!clerk ? <Badge tone="review" title="Clerk is not configured, so the dashboard is open to anyone who can reach it.">demo mode: no sign-in</Badge> : null}
      {error ? (
        <Badge tone="block"><WifiOff className="size-3" /> {state ? 'connection lost' : 'service unreachable'}</Badge>
      ) : a ? (
        <Badge tone={a.ok ? 'allow' : 'block'} title="The whole hash chain is re-verified on each poll.">
          {a.ok ? `ledger intact · ${a.length}` : `LEDGER TAMPERED at #${a.brokenAt}`}
        </Badge>
      ) : null}
      {updatedAt ? <span className="text-[11px] text-faint">updated {clock(new Date(updatedAt).toISOString())}</span> : null}
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { state, error } = useSentra();
  if (!state && error) {
    return (
      <div className="mx-auto max-w-xl rounded-lg border border-block/30 bg-block/[0.05] p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><WifiOff className="size-5 text-block" /> Cannot reach the guard service</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">Requests to <code className="font-mono text-foreground">{API_BASE}</code> are failing ({error}). Start the service and make sure it allows this origin via CORS, or point <code className="font-mono text-foreground">NEXT_PUBLIC_SENTRA_API</code> at it. This page keeps retrying every two seconds.</p>
      </div>
    );
  }
  if (!state) return <p className="text-sm text-muted">Loading...</p>;
  return <>{children}</>;
}

export function DashboardShell({ clerk, userSlot, children }: { clerk: boolean; userSlot?: React.ReactNode; children: React.ReactNode }) {
  return (
    <SentraProvider>
      <ToastProvider>
        <div className="min-h-dvh md:grid md:grid-cols-[220px_1fr]">
          <aside className="border-b border-line bg-surface/60 md:sticky md:top-0 md:h-dvh md:border-b-0 md:border-r">
            <div className="flex h-14 items-center justify-between px-4"><Logo href="/" />{userSlot ? <span className="md:hidden">{userSlot}</span> : null}</div>
            <div className="px-2 pb-2 md:px-3"><Nav /></div>
            <div className="hidden px-4 pt-6 text-[11px] leading-relaxed text-faint md:block">
              Sandbox and test mode only. No real money moves.
            </div>
          </aside>
          <div className="min-w-0">
            <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2 md:px-8">
              <Status clerk={clerk} />
              {userSlot ? <span className="hidden md:block">{userSlot}</span> : null}
            </header>
            <main className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8"><Gate>{children}</Gate></main>
          </div>
        </div>
      </ToastProvider>
    </SentraProvider>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{sub ? <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">{sub}</p> : null}</div>
      {actions}
    </div>
  );
}
