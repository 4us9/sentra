import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Github, Logo } from '@/components/app/brand';
import { buttonVariants } from '@/components/ui/button';
import { GITHUB_URL, LIVE_DEMO_URL } from '@/lib/env';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/#attack', label: 'The attack' },
  { href: '/#layers', label: 'How it works' },
  { href: '/docs', label: 'Docs' },
  { href: '/pricing', label: 'Pricing' },
];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line/80 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
          <Logo />
          <nav className="hidden items-center gap-5 md:flex" aria-label="Primary">
            {NAV.map((n) => <Link key={n.href} href={n.href} className="text-[13px] text-muted transition-colors hover:text-foreground">{n.label}</Link>)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a href={GITHUB_URL} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'hidden sm:inline-flex')} rel="noreferrer"><Github /> GitHub</a>
            <Link href="/dashboard" className={buttonVariants({ size: 'sm' })}>Open dashboard</Link>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs space-y-2">
            <Logo />
            <p className="text-[13px] leading-relaxed text-muted">A processor-agnostic firewall for agent-initiated payments. MIT licensed. Sandbox and test mode only: no real money moves.</p>
          </div>
          <div className="flex gap-12 text-[13px]">
            <ul className="space-y-2 text-muted">
              <li className="text-xs uppercase tracking-wider text-faint">Product</li>
              <li><Link href="/dashboard" className="hover:text-foreground">Dashboard</Link></li>
              <li><Link href="/docs" className="hover:text-foreground">Docs</Link></li>
              <li><Link href="/pricing" className="hover:text-foreground">Pricing</Link></li>
            </ul>
            <ul className="space-y-2 text-muted">
              <li className="text-xs uppercase tracking-wider text-faint">Source</li>
              <li><a href={GITHUB_URL} rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">GitHub <ArrowUpRight className="size-3" /></a></li>
              <li><a href={LIVE_DEMO_URL} rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">Live demo <ArrowUpRight className="size-3" /></a></li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  );
}
