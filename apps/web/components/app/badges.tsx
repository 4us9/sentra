import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { procShort, str } from '@/lib/format';
import type { ProcessorInfo } from '@/lib/types';

const TONE = { ALLOW: 'allow', BLOCK: 'block', REVIEW: 'review', ERROR: 'error', INFO: 'info', MIXED: 'accent' } as const;

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  const v = str(verdict, 12) || 'NONE';
  const tone = (TONE as Record<string, 'allow' | 'block' | 'review' | 'error' | 'info' | 'accent'>)[v] ?? 'neutral';
  return <Badge tone={tone} className={cn('min-w-[58px] justify-center', className)}>{v}</Badge>;
}

export const MODE_TEXT: Record<string, string> = {
  sandbox: 'Allowed payments are created in the processor sandbox and read back to verify amount and currency. No real money moves.',
  test: 'Allowed payments use test-mode keys and are read back to verify amount and currency. No real money moves.',
  simulated: 'Simulated: the service has no credentials for this processor, so allowed payments are not sent to it. Payment ids start with SIM-.',
  external: 'Authorise only: Sentra decides and records; the caller executes the payment itself.',
};
export const modeWord = (m: string) => (m === 'external' ? 'authorise only' : str(m, 20));
export const modeTone = (m: string) => (m === 'sandbox' || m === 'test' ? 'allow' : m === 'simulated' ? 'review' : 'neutral') as 'allow' | 'review' | 'neutral';

export function ProcessorTag({ name, processors, withMode = true }: { name: string; processors: ProcessorInfo[] | undefined; withMode?: boolean }) {
  const p = processors?.find((x) => x.name === name);
  const label = p ? procShort(str(p.label || p.name, 40)) : str(name, 40) || 'unknown';
  const tone = name === 'paypal' ? 'paypal' : name === 'stripe' ? 'stripe' : 'neutral';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone}>{label}</Badge>
      {withMode && p ? <Badge tone={modeTone(p.mode)} title={MODE_TEXT[p.mode]}>{modeWord(p.mode)}</Badge> : null}
    </span>
  );
}
