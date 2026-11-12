// Tiny .env loader (no dependency). Looks for .env at the repository root, so
// `pnpm --filter @sentra/service start` and `node dist/server.js` behave the same.
// Tests set SENTRA_NO_DOTENV so a developer's real keys can never be used by a test run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The monorepo root: the nearest ancestor with pnpm-workspace.yaml (else the cwd). */
export function repoRoot(): string {
  if (process.env.SENTRA_ROOT) return path.resolve(process.env.SENTRA_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const file = path.join(repoRoot(), '.env');
if (!process.env.SENTRA_NO_DOTENV && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
