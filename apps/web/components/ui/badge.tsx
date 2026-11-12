import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none tracking-wide', {
  variants: {
    tone: {
      neutral: 'border-line-strong text-muted',
      allow: 'border-transparent verdict-allow',
      block: 'border-transparent verdict-block',
      review: 'border-transparent verdict-review',
      error: 'border-error/35 bg-error/10 text-error',
      info: 'border-info/30 bg-info/10 text-info',
      accent: 'border-accent/35 bg-accent/10 text-accent',
      paypal: 'border-paypal/40 bg-paypal/10 text-paypal',
      stripe: 'border-stripe/40 bg-stripe/10 text-stripe',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
