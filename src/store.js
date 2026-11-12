// In-memory state with atomic write-through to data/db.json (tmp file + rename),
// so a crash mid-write can never leave a half-written ledger.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const dir = path.resolve(process.env.SENTRA_DATA_DIR || 'data');
const file = path.join(dir, 'db.json');
const secretFile = path.join(dir, 'secret.key');

const empty = () => ({ mandates: {}, decisions: [] });
let state = load();

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { mandates: s.mandates || {}, decisions: s.decisions || [] };
  } catch { return empty(); }
}

function persist() {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

const clone = (x) => (x === undefined ? undefined : structuredClone(x));

export function saveMandate(m) { state.mandates[m.id] = clone(m); persist(); return m; }
export function getMandate(id) { return clone(state.mandates[id]); }
export function listMandates() { return clone(Object.values(state.mandates)); }
export function appendDecision(d) { state.decisions.push(clone(d)); persist(); return d; }
export function listDecisions() { return clone(state.decisions); }
export function lastDecision() { return clone(state.decisions[state.decisions.length - 1]); }
export function reset() { state = empty(); persist(); }

// Test/demo hook: lets a test simulate an attacker editing the store directly.
export function _tamper(fn) { fn(state); }

// Server secret used to seal mandates. Env wins; otherwise generated once and kept
// next to the data so seals survive a restart.
let cachedSecret = null;
export function secret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.SENTRA_SECRET) return (cachedSecret = process.env.SENTRA_SECRET);
  try { cachedSecret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* first boot */ }
  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(secretFile, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}
