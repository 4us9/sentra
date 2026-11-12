export const API_BASE = (process.env.NEXT_PUBLIC_SENTRA_API || 'http://localhost:4000').replace(/\/+$/, '');
export const GITHUB_URL = 'https://github.com/4us9/sentra';
export const LIVE_DEMO_URL = 'https://sentra-x8zr.onrender.com';
/** Sign-in is only wired when both Clerk keys exist. The publishable key is inlined at build. */
export const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
