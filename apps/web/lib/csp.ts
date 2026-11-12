/**
 * Content-Security-Policy, built per request with a nonce.
 *
 * Everything an agent supplies (purpose, recipient, reasons, model text) reaches this
 * app as data and is rendered as React text children only. The CSP is the second wall:
 * even if a rendering bug slipped through, no inline or foreign script could run.
 */
export function buildCsp(nonce: string, opts: { dev: boolean; apiOrigin: string; clerk: boolean }): string {
  const script = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  if (opts.dev) script.push(`'unsafe-eval'`);
  const connect = [`'self'`, opts.apiOrigin];
  const img = [`'self'`, 'data:'];
  const frame: string[] = [];
  const style = [`'self'`, `'unsafe-inline'`]; // React style attributes and Next's runtime styles; no script impact.
  if (opts.clerk) {
    script.push('https://*.clerk.accounts.dev', 'https://challenges.cloudflare.com');
    connect.push('https://*.clerk.accounts.dev', 'https://clerk-telemetry.com');
    img.push('https://img.clerk.com');
    frame.push('https://challenges.cloudflare.com');
  }
  if (opts.dev) connect.push('ws:');
  return [
    `default-src 'self'`,
    `script-src ${script.join(' ')}`,
    `style-src ${style.join(' ')}`,
    `img-src ${img.join(' ')}`,
    `font-src 'self' data:`,
    `connect-src ${connect.join(' ')}`,
    frame.length ? `frame-src ${frame.join(' ')}` : `frame-src 'none'`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].filter(Boolean).join('; ');
}

export function apiOrigin(base: string): string {
  try { return new URL(base, 'http://localhost').origin; } catch { return ''; }
}
