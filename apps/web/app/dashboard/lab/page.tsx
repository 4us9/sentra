'use client';
import * as React from 'react';
import Link from 'next/link';
import { FlaskConical, Play, Send } from 'lucide-react';
import { PageHeader } from '@/components/app/shell';
import { ProcessorTag, VerdictBadge } from '@/components/app/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { agentTokenFor, guard, type GuardOutcome } from '@/lib/api';
import { decidingReason, decidingText, splitSource, str } from '@/lib/format';
import { useSentra } from '@/lib/store';
import { useToast } from '@/lib/toast';
import type { PaymentInput, Scenario } from '@/lib/types';
import { cn } from '@/lib/utils';

// Scenarios whose point is "every number passes, only the intent layer sees it".
const INTENT_STORY = new Set(['giftcard', 'offscope']);

interface Item {
  verdict?: string; id?: string; seq?: number; why?: string; frozen?: boolean;
  intent?: { text: string; source: string };
  error?: string; rate?: string; fatal?: boolean;
}

function toItem(o: GuardOutcome): Item {
  if (o.kind === 'auth') return { error: 'Agent token rejected (401). Issue a new mandate.', fatal: true };
  if (o.kind === 'rate') return { rate: `Rate limit reached for this agent token. Retry in ${o.retryAfterSec ?? 'a few'} seconds.`, fatal: true };
  if (o.kind === 'error') return { error: o.message };
  const d = o.decision;
  const dr = decidingReason(d);
  return {
    id: d.id, seq: d.seq, verdict: str(d.verdict, 12), why: decidingText(d),
    intent: dr && dr.layer === 'intent' && d.verdict !== 'ALLOW' ? splitSource(dr.detail) : undefined,
    frozen: Array.isArray(d.effects) && d.effects.includes('mandate_frozen'),
  };
}

function ResultLine({ it }: { it: Item }) {
  if (it.error) return <p className="text-[12.5px] text-block">{it.error}</p>;
  if (it.rate) return <p className="text-[12.5px] text-review">{it.rate}</p>;
  return (
    <div className="flex items-start gap-2.5 text-[12.5px]">
      <VerdictBadge verdict={it.verdict ?? ''} className="mt-px" />
      <Link href={`/dashboard/ledger/${encodeURIComponent(it.id ?? '')}`} className="mt-0.5 font-mono text-faint hover:text-accent">#{it.seq}</Link>
      <span className="min-w-0 break-words text-muted">{it.why}{it.frozen ? <b className="ml-1 text-review">circuit breaker froze the agent</b> : null}</span>
    </div>
  );
}

function Callout({ it }: { it: Item }) {
  if (!it.intent) return null;
  const llm = it.intent.source === 'llm';
  return (
    <div className={cn('mt-2 rounded-md border p-3 text-[13px]', it.verdict === 'REVIEW' ? 'border-review/40 bg-review/[0.06]' : 'border-error/40 bg-error/[0.06]')}>
      <p className="flex items-center gap-2 font-medium">{llm ? 'Only the AI layer caught this' : 'Caught by the intent layer'}{it.intent.source ? <Badge tone="accent">{it.intent.source}</Badge> : null}</p>
      <p className="mt-1 text-muted">{it.intent.text || 'intent check'}</p>
    </div>
  );
}

function summarise(items: Item[]) {
  const c: Record<string, number> = {};
  for (const i of items) if (i.verdict) c[i.verdict] = (c[i.verdict] ?? 0) + 1;
  return ['ALLOW', 'BLOCK', 'REVIEW', 'ERROR'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(' · ') + (items.some((i) => i.frozen) ? ' · circuit breaker froze the agent' : '');
}

export default function Lab() {
  const { state, scenarios, poisoned, currentMandate, selectMandate, refresh, tokenRev } = useSentra();
  const toast = useToast();
  const [results, setResults] = React.useState<Record<string, Item[]>>({});
  const [running, setRunning] = React.useState<string | null>(null);
  const [craft, setCraft] = React.useState({ amount: '25', recipient: '', purpose: '' });
  const [crafted, setCrafted] = React.useState<Item | null>(null);

  const m = currentMandate;
  const token = React.useMemo(() => (m ? agentTokenFor(m.id) : null), [m, tokenRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const off = !token;
  const recipients = React.useMemo(() => [...new Set(scenarios.flatMap((s) => s.steps.map((x) => str(x.recipient, 128))))], [scenarios]);
  if (!state) return null;

  async function run(sc: Scenario) {
    if (!token || running) return;
    setRunning(sc.id);
    setResults((r) => ({ ...r, [sc.id]: [] }));
    const steps: PaymentInput[] = sc.steps.map((s) => ({ amount: s.amount, recipient: s.recipient, purpose: s.purpose }));
    try {
      if (sc.concurrent) {
        // Fired in the same tick: the race the per-mandate lock has to win.
        const items = (await Promise.all(steps.map((s) => guard(token, s)))).map(toItem);
        setResults((r) => ({ ...r, [sc.id]: items }));
      } else {
        const items: Item[] = [];
        for (const s of steps) {
          const it = toItem(await guard(token, s));
          items.push(it);
          setResults((r) => ({ ...r, [sc.id]: [...items] }));
          if (it.fatal) break;
        }
      }
    } catch (e) {
      setResults((r) => ({ ...r, [sc.id]: [{ error: `Request failed: ${e instanceof Error ? e.message : 'error'}` }] }));
    } finally {
      setRunning(null);
      await refresh();
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!token || running) return;
    setRunning('__craft');
    const raw = craft.amount.trim();
    // Plain decimals go as numbers; anything else is sent verbatim so the schema layer has to deal with it.
    const amount = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    try { setCrafted(toItem(await guard(token, { amount, recipient: craft.recipient, purpose: craft.purpose }))); }
    catch (err) { setCrafted({ error: `Request failed: ${err instanceof Error ? err.message : 'error'}` }); }
    finally { setRunning(null); await refresh(); }
  }

  return (
    <>
      <PageHeader title="Attack Lab" sub="You are the hijacked agent. Fire the scenarios at the selected mandate using its agent token, exactly as an agent would over POST /guard, then try to craft a payment that gets through." />

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-3 pt-5 md:flex-row md:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="lab-mandate">Target mandate</Label>
            <Select value={m?.id} onValueChange={selectMandate} disabled={!state.mandates.length}>
              <SelectTrigger id="lab-mandate"><SelectValue placeholder="No mandate" /></SelectTrigger>
              <SelectContent>
                {[...state.mandates].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((x) => (
                  <SelectItem key={x.id} value={x.id}>{`${x.processor} · ${str(x.policy, 40) || 'custom'} · ${str(x.id, 24)}${x.status === 'frozen' ? ' (frozen)' : ''}${agentTokenFor(x.id) ? '' : ' (no agent token)'}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {m ? <ProcessorTag name={m.processor} processors={state.config.processors} /> : null}
        </CardContent>
        {off ? (
          <p className="border-t border-line px-5 py-3 text-[13px] text-review">
            {!m ? <>The lab is disabled: there is no mandate. <Link href="/dashboard/mandates" className="underline">Issue one</Link> to receive its agent token.</>
              : <>The lab is disabled: this tab does not hold the agent token for this mandate. Tokens are shown once, when the mandate is issued, and kept only in this tab. <Link href="/dashboard/mandates" className="underline">Issue a fresh mandate</Link> to continue.</>}
          </p>
        ) : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {scenarios.length === 0 ? <p className="text-sm text-muted">No scenarios available.</p> : null}
        {scenarios.map((sc) => {
          const items = results[sc.id];
          const shown = (items ?? []).filter((i) => !i.rate);
          const story = INTENT_STORY.has(sc.id) && shown.length === 1 ? shown[0] : undefined;
          const rate = (items ?? []).find((i) => i.rate);
          const attack = sc.category !== 'legit';
          return (
            <Card key={sc.id} className={cn('flex flex-col', attack ? '' : 'border-allow/25')}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Badge tone={attack ? 'block' : 'allow'}>{attack ? 'attack' : 'legitimate'}</Badge>
                  <span className="text-[11px] text-faint">{sc.steps.length === 1 ? '1 payment' : `${sc.steps.length} ${sc.concurrent ? 'at once' : 'payments'}`}</span>
                </div>
                <CardTitle className="mt-2 text-[15px]">{str(sc.title, 120)}</CardTitle>
                <CardDescription>{str(sc.blurb, 400)}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-3">
                {sc.id === 'hijack' && poisoned ? <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-background/60 p-3 font-mono text-[11.5px] leading-relaxed text-faint" title="The poisoned listing the agent read, shown as inert text.">{poisoned.trim()}</pre> : null}
                <div className="space-y-1.5" aria-live="polite">
                  {shown.map((it, i) => <ResultLine key={i} it={it} />)}
                  {story ? <Callout it={story} /> : null}
                  {shown.length > 1 && running !== sc.id ? <p className="text-[12.5px] text-muted">{summarise(shown)}</p> : null}
                  {rate ? <p className="text-[12.5px] text-review">{rate.rate}</p> : null}
                </div>
                <div className="flex items-center justify-between border-t border-line pt-3">
                  <span className="flex items-center gap-2 text-[12px] text-faint">Expect <VerdictBadge verdict={sc.expect} /></span>
                  <Button size="sm" variant={attack ? 'outline' : 'default'} onClick={() => run(sc)} disabled={off || Boolean(running)}>
                    <Play />{running === sc.id ? 'Running' : items ? 'Run again' : 'Run'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FlaskConical className="size-4 text-accent" /> Craft your own payment</CardTitle>
          <CardDescription>Sent verbatim to POST /guard. Try Unicode look-alikes, odd amounts like 1e3, or a purpose that addresses the reviewer model. If one gets through, it is a finding.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={send} className="grid gap-3 md:grid-cols-[120px_1fr]">
            <div className="space-y-1.5"><Label htmlFor="c-amt">Amount</Label><Input id="c-amt" value={craft.amount} onChange={(e) => setCraft({ ...craft, amount: e.target.value })} disabled={off} inputMode="decimal" required /></div>
            <div className="space-y-1.5"><Label htmlFor="c-rec">Recipient</Label><Input id="c-rec" list="recipients" value={craft.recipient} onChange={(e) => setCraft({ ...craft, recipient: e.target.value })} disabled={off} maxLength={200} required />
              <datalist id="recipients">{recipients.map((r) => <option key={r} value={r} />)}</datalist></div>
            <div className="space-y-1.5 md:col-span-2"><Label htmlFor="c-pur">Purpose</Label><Textarea id="c-pur" value={craft.purpose} onChange={(e) => setCraft({ ...craft, purpose: e.target.value })} disabled={off} maxLength={600} required /></div>
            <div className="md:col-span-2 flex flex-wrap items-center gap-4">
              <Button type="submit" disabled={off || Boolean(running)}><Send />{running === '__craft' ? 'Sending' : 'Send payment'}</Button>
              {crafted ? <div className="min-w-0 flex-1"><ResultLine it={crafted} /><Callout it={crafted} /></div> : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
