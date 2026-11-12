import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { ClerkProvider } from '@clerk/nextjs';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { CLERK_ENABLED } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sentra: the firewall between AI agents and the money', template: '%s | Sentra' },
  description: 'Sentra inspects every payment an AI agent attempts, on PayPal or Stripe, before it executes, and refuses the hijacked ones. Open source. Sandbox only.',
};
export const viewport: Viewport = { themeColor: '#090b0f', colorScheme: 'dark' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers makes every page dynamic, which is what lets Next
  // stamp the per-request CSP nonce (set in middleware.ts) onto its own scripts.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const page = (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
  return CLERK_ENABLED ? <ClerkProvider nonce={nonce}>{page}</ClerkProvider> : page;
}
