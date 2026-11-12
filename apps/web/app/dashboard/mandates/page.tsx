'use client';
import Link from 'next/link';
import { PageHeader } from '@/components/app/shell';
import { ProcessorTag } from '@/components/app/badges';
import { BudgetBar } from '@/components/app/budget-bar';
import { IssueMandate } from '@/components/app/issue-mandate';
import { mandateStatus } from '@/components/app/mandate-detail';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { agentTokenFor } from '@/lib/api';
import { str } from '@/lib/format';
import { useSentra } from '@/lib/store';

export default function Mandates() {
  const { state } = useSentra();
  if (!state) return null;
  const ms = [...state.mandates].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return (
    <>
      <PageHeader title="Mandates" sub="A mandate is the authority a human delegates to an agent: budget, per-payment cap, allowed recipients, velocity, expiry and the rail that executes. It is sealed, so the agent cannot widen or reroute it." />
      <IssueMandate />
      <h2 className="mb-3 mt-8 text-[13px] font-semibold">Issued ({ms.length})</h2>
      {ms.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {ms.map((m) => {
            const st = mandateStatus(m);
            return (
              <Link key={m.id} href={`/dashboard/mandates/${encodeURIComponent(m.id)}`} className="group block">
                <Card className="space-y-4 p-5 transition-colors group-hover:border-line-strong">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={st.tone}>{st.text}</Badge>
                    <ProcessorTag name={m.processor} processors={state.config.processors} />
                    {agentTokenFor(m.id) ? <Badge tone="accent" title="This tab holds the agent token, so the Attack Lab can act as this agent.">token held</Badge> : null}
                  </div>
                  <div>
                    <p className="text-[14px] font-medium">{m.policy ? str(m.policy, 64) : 'custom mandate'}</p>
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{str(m.description, 200)}</p>
                  </div>
                  <BudgetBar m={m} />
                  <p className="font-mono text-[11px] text-faint">{str(m.id, 60)}</p>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : <p className="rounded-lg border border-dashed border-line-strong p-6 text-sm text-muted">No mandate yet. Choose a policy and a processor above, then issue one.</p>}
    </>
  );
}
