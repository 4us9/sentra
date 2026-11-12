import { CheckCircle2, CircleAlert, CircleDot, XCircle } from 'lucide-react';
import { layerName, splitSource, str } from '@/lib/format';
import type { Reason } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const BAD = new Set(['FAIL', 'FLAG', 'high', 'med', 'error']);

/** The full check trace of a decision. Every string is rendered as a text child. */
export function Trace({ reasons, decidedBy }: { reasons: Reason[]; decidedBy: { layer: string; check: string } | null }) {
  if (!reasons?.length) return <p className="text-sm text-muted">No checks recorded.</p>;
  return (
    <ol className="space-y-1.5">
      {reasons.map((r, i) => {
        const bad = BAD.has(r.result);
        const decisive = Boolean(decidedBy && r.layer === decidedBy.layer && r.check === decidedBy.check);
        const isIntent = r.layer === 'intent';
        const { text, source } = isIntent ? splitSource(r.detail) : { text: str(r.detail, 600), source: '' };
        const Icon = bad ? XCircle : r.result === 'info' ? CircleDot : r.result === 'pass' || r.result === 'ok' || r.result === 'low' ? CheckCircle2 : CircleAlert;
        return (
          <li key={i} className={cn('flex gap-3 rounded-md border px-3 py-2', decisive ? 'border-block/40 bg-block/[0.06]' : 'border-line bg-background/40')}>
            <Icon className={cn('mt-0.5 size-4 shrink-0', bad ? 'text-block' : r.result === 'info' ? 'text-info' : 'text-allow')} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-faint">{layerName(str(r.layer, 20))}</span>
                <span className="font-mono text-[13px] text-foreground">{str(r.check, 80)}</span>
                <Badge tone={bad ? 'block' : 'neutral'}>{str(r.result, 12)}</Badge>
                {source ? <Badge tone="accent">{source}</Badge> : null}
                {decisive ? <Badge tone="block">decided</Badge> : null}
              </div>
              {text ? <p className="mt-1 break-words text-[13px] leading-relaxed text-muted">{text}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
