// Tiny .env loader (no dependency) so `npm install` stays fast.
import fs from 'fs';
import path from 'path';

const file = path.resolve('.env');
// Tests set SENTRA_NO_DOTENV so a developer's real keys can never be used by a test run.
if (!process.env.SENTRA_NO_DOTENV && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
