import { cn } from '@/lib/utils';

export function CodeBlock({ title, children, className }: { title?: string; children: string; className?: string }) {
  return (
    <div className={cn('min-w-0 max-w-full overflow-hidden rounded-lg border border-line bg-surface', className)}>
      {title ? (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="font-mono text-[11px] text-faint">{title}</span>
        </div>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-[1.7] text-foreground/90"><code>{children}</code></pre>
    </div>
  );
}
