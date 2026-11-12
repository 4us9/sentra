import type { NextConfig } from 'next';

// The CSP is set per request in middleware.ts (it needs a nonce). The static
// headers here are the ones that never vary.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  // Local testing only: SENTRA_DEV_PROXY=http://localhost:4000 lets the browser reach a
  // guard service that has no CORS (the legacy Express server) through this origin.
  // Point NEXT_PUBLIC_SENTRA_API at http://localhost:3100/sentra-api to use it.
  async rewrites() {
    const target = process.env.SENTRA_DEV_PROXY;
    return target ? [{ source: '/sentra-api/:path*', destination: `${target.replace(/\/$/, '')}/:path*` }] : [];
  },
};

export default config;
