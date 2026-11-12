import { NextResponse, type NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { apiOrigin, buildCsp } from '@/lib/csp';

const clerkOn = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
const isProtected = createRouteMatcher(['/dashboard(.*)']);

function withCsp(req: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV !== 'production',
    apiOrigin: apiOrigin(process.env.NEXT_PUBLIC_SENTRA_API || 'http://localhost:4000'),
    clerk: clerkOn,
  });
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

// Without both Clerk keys the dashboard is open ("demo mode") and Clerk is never touched.
export default clerkOn
  ? clerkMiddleware(async (auth, req) => {
      if (isProtected(req)) await auth.protect();
      return withCsp(req);
    })
  : function middleware(req: NextRequest) {
      return withCsp(req);
    };

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|txt)$).*)'],
};
