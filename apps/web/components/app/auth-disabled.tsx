import Link from 'next/link';
import { Logo } from './brand';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function AuthDisabled({ mode }: { mode: 'in' | 'up' }) {
  return (
    <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6">
      <Logo />
      <h1 className="mt-6 text-xl font-semibold tracking-tight">Sign-{mode} is disabled</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-muted">
        This instance runs in <Badge tone="review">demo mode</Badge> because Clerk is not configured. The dashboard is open and needs no account.
        To turn sign-in on, set <code className="font-mono text-[13px] text-foreground">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and <code className="font-mono text-[13px] text-foreground">CLERK_SECRET_KEY</code>; see <code className="font-mono text-[13px] text-foreground">apps/web/README.md</code>.
      </p>
      <Link href="/dashboard" className={buttonVariants({ className: 'mt-6' })}>Continue to the dashboard</Link>
    </div>
  );
}
