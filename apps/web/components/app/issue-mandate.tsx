'use client';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { modeWord, modeTone, MODE_TEXT } from './badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { issueMandate, storeAgentToken } from '@/lib/api';
import { money, procShort, str } from '@/lib/format';
import { useSentra } from '@/lib/store';
import { useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function IssueMandate({ onIssued }: { onIssued?: (id: string) => void }) {
  const { state, policies, defaultPolicy, refresh, selectMandate, bumpTokens } = useSentra();
  const toast = useToast();
  const procs = state?.config.processors ?? [];
  const [policy, setPolicy] = React.useState<string | null>(null);
  const [proc, setProc] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const policyName = policy && policies.some((p) => p.name === policy) ? policy : (defaultPolicy ?? policies[0]?.name ?? null);
  const procName = proc && procs.some((p) => p.name === proc) ? proc : (procs.find((p) => p.default) ?? procs[0])?.name ?? null;
  const pol = policies.find((p) => p.name === policyName);
  const chosen = procs.find((p) => p.name === procName);

  async function issue() {
    setBusy(true);
    try {
      const r = await issueMandate({ ...(policyName ? { policy: policyName } : {}), ...(procName ? { processor: procName } : {}) });
      if (r?.mandate?.id && typeof r.agentToken === 'string') {
        storeAgentToken(r.mandate.id, r.agentToken); // shown once by the service; kept in this tab only
        bumpTokens();
        selectMandate(r.mandate.id);
        toast(`Mandate ${str(r.mandate.id, 40)} issued. Its agent token is held in this tab for the Attack Lab.`, true);
        onIssued?.(r.mandate.id);
      }
      await refresh();
    } catch (e) { toast(`Could not issue mandate: ${e instanceof Error ? e.message : 'error'}`); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Issue a mandate</CardTitle>
        <CardDescription>You are the human: pick what the agent is authorised to do and which rail executes an ALLOW. The agent token is shown once and kept only in this tab.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="policy">Policy</Label>
            <Select value={policyName ?? undefined} onValueChange={setPolicy} disabled={!policies.length}>
              <SelectTrigger id="policy"><SelectValue placeholder={policies.length ? 'Choose a policy' : 'Server default'} /></SelectTrigger>
              <SelectContent>{policies.map((p) => <SelectItem key={p.name} value={p.name}>{str(p.name, 64)}{p.name === defaultPolicy ? ' (default)' : ''}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Processor</Label>
            <div role="radiogroup" aria-label="Processor" className="flex flex-wrap gap-2">
              {procs.map((p) => {
                const on = p.name === procName;
                return (
                  <button key={p.name} type="button" role="radio" aria-checked={on} title={MODE_TEXT[p.mode]} onClick={() => setProc(p.name)}
                    className={cn('flex h-9 min-w-[120px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-2 text-[13px] transition-colors', on ? (p.name === 'paypal' ? 'border-paypal/60 bg-paypal/10 text-foreground' : 'border-accent/60 bg-accent/10 text-foreground') : 'border-line-strong text-muted hover:bg-surface-2')}>
                    {procShort(str(p.label || p.name, 30))}
                    <Badge tone={modeTone(p.mode)} className="px-1 py-0.5 text-[10px]">{modeWord(p.mode)}</Badge>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {pol ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted" title={str(pol.description, 400)}>
            <b className="text-foreground">{money(pol.budgetTotal, pol.currency)}</b> budget ·
            <b className="text-foreground">{money(pol.perTxCap, pol.currency)}</b> per payment ·
            <b className="text-foreground">{pol.allowedRecipients?.length ?? 0}</b> recipients ·
            out of scope <b className={pol.outOfScope === 'block' ? 'text-block' : 'text-review'}>{pol.outOfScope === 'block' ? 'blocked' : 'held for review'}</b>
          </p>
        ) : null}
        <Button onClick={issue} disabled={busy || !state}><Plus />{busy ? 'Issuing...' : chosen ? `Issue mandate on ${procShort(str(chosen.label || chosen.name, 30))}` : 'Issue mandate'}</Button>
      </CardContent>
    </Card>
  );
}
