'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/app/shell';
import { MandateDetail } from '@/components/app/mandate-detail';
import { VerdictBadge } from '@/components/app/badges';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { clock, decidingText, money, str } from '@/lib/format';
import { useSentra } from '@/lib/store';

export default function MandatePage() {
  const { id } = useParams<{ id: string }>();
  const { state } = useSentra();
  if (!state) return null;
  const m = state.mandates.find((x) => x.id === id);
  if (!m) {
    return (<><Link href="/dashboard/mandates" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"><ChevronLeft className="size-4" /> Mandates</Link>
      <p className="text-sm text-muted">No mandate with that id.</p></>);
  }
  const mine = state.decisions.filter((d) => d.mandateId === m.id).slice().reverse().slice(0, 30);
  return (
    <>
      <Link href="/dashboard/mandates" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"><ChevronLeft className="size-4" /> Mandates</Link>
      <PageHeader title={m.policy ? str(m.policy, 64) : 'Custom mandate'} sub={str(m.id, 60)} />
      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <MandateDetail m={m} />
        <Card>
          <CardHeader><CardTitle>Activity under this mandate</CardTitle></CardHeader>
          {mine.length ? (
            <ul className="divide-y divide-line/70 pb-2">
              {mine.map((d) => (
                <li key={d.id}>
                  <Link href={`/dashboard/ledger/${encodeURIComponent(d.id)}`} className="flex items-center gap-3 px-5 py-2 text-[13px] hover:bg-surface-2/60">
                    <span className="font-mono text-faint">#{d.seq}</span>
                    <VerdictBadge verdict={d.verdict} />
                    <span className="font-mono tabular-nums">{d.kind === 'payment' ? money(d.request?.amount, d.request?.currency) : d.kind}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{decidingText(d)}</span>
                    <span className="hidden font-mono text-faint sm:block">{clock(d.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 pb-5 text-sm text-muted">Nothing yet.</p>}
        </Card>
      </div>
    </>
  );
}
