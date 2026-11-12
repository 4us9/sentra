# @sentra/web

Landing page, docs and operator dashboard for Sentra. Next.js 15 (App Router), React 19, Tailwind v4, shadcn-style components (Radix) in `components/ui`, TanStack Table for the ledger, lucide icons. No CDN assets.

## Run

```bash
corepack pnpm@9.15.0 --filter @sentra/web dev      # http://localhost:3100
corepack pnpm@9.15.0 --filter @sentra/web build
corepack pnpm@9.15.0 --filter @sentra/web start
corepack pnpm@9.15.0 --filter @sentra/web typecheck
corepack pnpm@9.15.0 --filter @sentra/web test
```

The build needs no environment variables.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SENTRA_API` | `http://localhost:4000` | Guard service the browser calls directly. Inlined at build time. The service must allow this app's origin via CORS. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | unset | Turn on sign-in for `/dashboard`. Both must be set. |
| `SENTRA_DEV_PROXY` | unset | Dev only. Rewrites `/sentra-api/*` to this URL so a service without CORS can be used: set `NEXT_PUBLIC_SENTRA_API=http://localhost:3100/sentra-api` too. |

## Sign-in with Clerk (optional)

Without both Clerk keys the dashboard is open and shows a "demo mode: no sign-in" badge, and `/sign-in` and `/sign-up` explain that sign-in is disabled.

1. Create an application at https://dashboard.clerk.com and choose the sign-in methods you want.
2. Copy the publishable key and the secret key from **API keys**.
3. Put them in `apps/web/.env.local` (gitignored), or in your host's environment:
   ```
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```
4. In Clerk **Paths** set sign-in to `/sign-in` and sign-up to `/sign-up` (optionally add `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`).
5. Rebuild (the publishable key is inlined at build time) and restart.

`middleware.ts` then protects `/dashboard(.*)`. Signed-in users reach the dashboard; others are redirected to sign in. The guard service's own operator token (`SENTRA_ADMIN_TOKEN`, entered under Settings) is a separate control: Clerk gates this UI, the token gates the API.

## Security

Everything inside a decision (purpose, recipient, reasons, model text) is attacker-controlled. It is rendered only as React text children: no `dangerouslySetInnerHTML`, nothing from the API in `href`, `src` or `style`. `lib/format.ts` bounds every string. Agent tokens live in `sessionStorage` for the Attack Lab only, never in a URL.

The CSP is built per request in `middleware.ts` (`lib/csp.ts`) with a nonce and `strict-dynamic`; no `unsafe-eval` in production. The root layout reads request headers so every page is dynamic and Next can stamp the nonce on its scripts.
