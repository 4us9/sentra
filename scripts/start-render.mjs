// Render runs the guard API and the Next.js UI in one free instance (512 MB).
//
//   public  PORT       Next.js (landing + dashboard); /sentra-api/* is proxied to the API
//   private 127.0.0.1:SENTRA_API_PORT   the Fastify guard service
//
// Both are started with `node` directly, not through `pnpm --filter ... start`:
// each pnpm wrapper costs ~100 MB of RSS, and two of them pushed the instance past
// 512 MB, so Render killed and restarted it in a loop. Heaps are capped for the
// same reason.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicPort = process.env.PORT || '3000';
const apiPort = process.env.SENTRA_API_PORT || '4000';
const heap = (mb) => [process.env.NODE_OPTIONS, `--max-old-space-size=${mb}`].filter(Boolean).join(' ');

const api = spawn(process.execPath, [path.join(root, 'packages/service/dist/server.js')], {
  cwd: root,
  env: { ...process.env, PORT: apiPort, HOST: '127.0.0.1', NODE_OPTIONS: heap(Number(process.env.SENTRA_API_HEAP_MB || 128)) },
  stdio: 'inherit',
});
const web = spawn(process.execPath, [path.join(root, 'apps/web/node_modules/next/dist/bin/next'), 'start', '-p', publicPort, '-H', '0.0.0.0'], {
  cwd: path.join(root, 'apps/web'),
  env: { ...process.env, PORT: publicPort, NODE_OPTIONS: heap(Number(process.env.SENTRA_WEB_HEAP_MB || 192)) },
  stdio: 'inherit',
});

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  web.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
};
api.once('exit', (code) => { if (!stopping) { console.error(`[start-render] API exited (${code})`); stop(code || 1); } });
web.once('exit', (code) => { if (!stopping) { console.error(`[start-render] web exited (${code})`); stop(code || 1); } });
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
