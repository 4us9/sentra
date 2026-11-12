'use client';
import * as React from 'react';
import { ShieldAlert, Snowflake } from 'lucide-react';
import { ProcessorTag } from './badges';
import { BudgetBar } from './budget-bar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { freezeMandate, reinstateMandate } from '@/lib/api';
import { dateTime, remaining, str } from '@/lib/format';
import { useSentra, useHasAgentToken } from '@/lib/store';
import { useToast } from '@/lib/toast';
import type { Mandate } from '@/lib/types';

export function mandateStatus(m: Mandate): { text: string; tone: 'allow' | 'block' | 'review' | 'neutral' } {
  if (m.sealValid === false) return { text: 'SEAL BROKEN', tone: 'block' };
  if (m.status === 'frozen') return { text: 'FROZEN', tone: 'review' };
  if (remaining(m.expiresAt).expired) return { text: 'EXPIRED', tone: 'neutral' };
  return { text: 'ACTIVE', tone: 'allow' };
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[130px_1fr] gap-3 border-b border-line/60 py-2 text-[13px] last:border-0"><dt className="text-faint">{k}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

export function MandateDetail({ m }: { m: Mandate }) {
  const { state, refresh } = useSentra();
  const toast = useToast();
  const hasToken = useHasAgentToken(m.id);
  const [busy, setBusy] = React.useState(false);
  const st = mandateStatus(m);
  const rem = remaining(m.expiresAt);
  const frozen = m.status === 'frozen';

  async function toggle() {
    setBusy(true);
    try { await (frozen ? reinstateMandate : freezeMandate)(m.id); await refresh(); }
    catch (e) { toast(`${frozen ? 'Reinstate' : 'Freeze'} failed: ${e instanceof Error ? e.message : 'error'}`); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={st.tone}>{st.text}</Badge>
          <ProcessorTag name={m.processor} processors={state?.config.processors} />
          {m.policy ? <Badge tone="accent">{str(m.policy, 64)}</Badge> : <Badge>custom</Badge>}
          <div className="ml-auto">
            {frozen
              ? <Button size="sm" onClick={toggle} disabled={busy}>Reinstate agent</Button>
              : <Button size="sm" variant="danger" onClick={toggle} disabled={busy} title="Freeze this mandate now. Every payment from the agent is refused until you reinstate it."><Snowflake /> Kill switch</Button>}
          </div>
        </div>

        {m.sealValid === false ? (
          <div className="flex gap-3 rounded-md border border-block/40 bg-block/[0.07] p-3 text-[13px]" role="alert">
            <ShieldAlert className="size-4 shrink-0 text-block" />
            <p><strong>Mandate seal does not verify.</strong> The stored mandate was modified after it was issued. Every payment under it is blocked.</p>
          </div>
        ) : null}
        {frozen ? (
          <div className="rounded-md border border-review/40 bg-review/[0.07] p-3 text-[13px]" role="alert">
            <strong>Agent frozen.</strong> <span className="text-muted">{str(m.frozenReason, 300) || 'frozen'}. All payments are refused until a human reinstates it.</span>
          </div>
        ) : null}

        <p className="text-[14px] leading-relaxed text-muted">{str(m.description, 400)}</p>
        <BudgetBar m={m} />

        <dl>
          <Row k="Mandate id"><span className="font-mono text-xs">{str(m.id, 60)}</span></Row>
          <Row k="Issued for">{str(m.user, 80)}</Row>
          <Row k="Per-payment cap"><span className="font-mono">{str(m.perTxCap, 20)} {str(m.currency, 6)}</span></Row>
          <Row k="Recipients"><span className="flex flex-wrap gap-1.5">{(m.allowedRecipients ?? []).slice(0, 40).map((r) => <Badge key={r}>{str(r, 140)}</Badge>)}</span></Row>
          <Row k="Velocity">{str(m.velocityLimit?.count, 10)} payments per {str(m.velocityLimit?.windowSec, 10)}s</Row>
          <Row k="Circuit breaker">{str(m.breaker?.blocks, 10)} blocks in {str(m.breaker?.windowSec, 10)}s freezes the agent</Row>
          <Row k="Out of scope">an ordinary purchase outside the purpose is <strong className={m.outOfScope === 'block' ? 'text-block' : 'text-review'}>{m.outOfScope === 'block' ? 'blocked' : 'held for review'}</strong></Row>
          {m.scope?.length ? <Row k="Scope"><span className="flex flex-wrap gap-1.5">{m.scope.slice(0, 40).map((s) => <Badge key={s} tone="info">{str(s, 60)}</Badge>)}</span></Row> : null}
          <Row k="Expires">{rem.text} <span className="text-faint">({dateTime(m.expiresAt)})</span></Row>
          <Row k="Agent token">{hasToken ? 'held in this tab; the Attack Lab acts as the agent' : <span className="text-faint">not held by this tab</span>}</Row>
        </dl>
      </CardContent>
    </Card>
  );
}
