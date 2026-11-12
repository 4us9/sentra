'use client';
import * as React from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { PageHeader } from '@/components/app/shell';
import { ProcessorTag } from '@/components/app/badges';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { resolveReview } from '@/lib/api';
import { decidingText, money, pendingReviews, str } from '@/lib/format';
import { useSentra } from '@/lib/store';
import { useToast } from '@/lib/toast';

export default function Reviews() {
  const { state, refresh } = useSentra();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!state) return null;
  const pend = pendingReviews(state.decisions).slice().reverse();

  async function act(id: string, action: 'approve' | 'deny') {
    setBusy(id);
    try {
      const d = await resolveReview(id, action);
      if (action === 'deny') toast(`Denied. Recorded as #${d.seq}; the processor was never called.`, true);
      else if (d.verdict === 'ALLOW') toast(`Approved and ${d.processor === 'external' ? 'authorised' : 'executed'} as #${d.seq}${d.paymentId ? ' · ' + str(d.paymentId, 60) : ''}.`, true);
      else toast(`Approved, but not executed (#${d.seq}): ${decidingText(d)}`);
      await refresh();
    } catch (e) { toast(`Review ${action} failed: ${e instanceof Error ? e.message : 'error'}`); }
    finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Review queue" sub="Payments held for a human. Nothing reaches a processor until you approve, and approval re-runs every rule against the mandate as it stands now." />
      {pend.length ? (
        <div className="space-y-3">
          {pend.map((d) => (
            <Card key={d.id} className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Link href={`/dashboard/ledger/${encodeURIComponent(d.id)}`} className="font-mono text-xs text-accent hover:underline">#{d.seq}</Link>
                  <span className="font-mono text-lg font-semibold tabular-nums">{money(d.request?.amount, d.request?.currency)}</span>
                  <span className="font-mono text-[13px] text-muted">{str(d.request?.recipient, 128)}</span>
                  <ProcessorTag name={d.processor} processors={state.config.processors} withMode={false} />
                </div>
                <p className="break-words text-[14px]">{str(d.request?.purpose, 500)}</p>
                <p className="text-[12.5px] text-review">{decidingText(d)}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="allow" onClick={() => act(d.id, 'approve')} disabled={busy === d.id}><Check /> Approve</Button>
                <Button variant="danger" onClick={() => act(d.id, 'deny')} disabled={busy === d.id}><X /> Deny</Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line-strong p-8 text-center text-sm text-muted">Nothing is waiting. Run <Link href="/dashboard/lab" className="text-accent hover:underline">Off-mandate purchase</Link> in the Attack Lab to see a held payment.</p>
      )}
    </>
  );
}
