import { isNum, money } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Mandate } from '@/lib/types';

export function BudgetBar({ m, className }: { m: Mandate; className?: string }) {
  const spent = isNum(m.spent) ? m.spent : 0;
  const total = isNum(m.budgetTotal) && m.budgetTotal > 0 ? m.budgetTotal : 0;
  const held = isNum(m.reserved) && m.reserved > 0 ? m.reserved : 0;
  const pct = total ? Math.max(0, Math.min(100, (spent / total) * 100)) : 0;
  const hpct = total ? Math.max(0, Math.min(100 - pct, (held / total) * 100)) : 0;
  const used = pct + hpct;
  const left = Math.max(0, Math.round((total - spent - held) * 100) / 100);
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span><span className="font-mono text-lg font-semibold tabular-nums">{money(spent, m.currency)}</span><span className="ml-1.5 text-xs text-muted">spent of {money(m.budgetTotal, m.currency)}</span></span>
        <span className="text-xs text-muted tabular-nums">{money(left, m.currency)} left</span>
      </div>
      <div role="progressbar" aria-label="Budget used, including reservations" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}
        className="flex h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line">
        <span className={cn('h-full', used >= 100 ? 'bg-block' : used >= 80 ? 'bg-review' : 'bg-accent')} style={{ width: `${pct}%` }} />
        {held ? <span className="h-full bg-accent/40" style={{ width: `${Math.max(hpct, 1.5)}%` }} title={`${money(held, m.currency)} reserved by payments executing now`} /> : null}
      </div>
      {held ? <p className="flex items-center gap-1.5 text-xs text-muted"><i className="inline-block size-2 rounded-full bg-accent/40" />{money(held, m.currency)} reserved in flight</p> : null}
    </div>
  );
}
