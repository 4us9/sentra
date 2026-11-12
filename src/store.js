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

// Indexes, rebuilt from state whenever it is replaced. They keep the hot path
// (one /guard call) from scanning every mandate and every decision ever made.
let byToken = new Map();        // tokenHash -> mandateId
let byMandate = new Map();      // mandateId -> decisions[] (same objects as state.decisions)
function reindex() {
  byToken = new Map(Object.values(state.mandates).map((m) => [m.tokenHash, m.id]));
  byMandate = new Map();
  for (const d of state.decisions) {
    if (!byMandate.has(d.mandateId)) byMandate.set(d.mandateId, []);
    byMandate.get(d.mandateId).push(d);
  }
}
reindex();

export function saveMandate(m) {
  state.mandates[m.id] = clone(m);
  byToken.set(m.tokenHash, m.id);
  persist();
  return m;
}
export function getMandate(id) { return clone(state.mandates[id]); }
export function mandateByTokenHash(hash) {
  const id = byToken.get(hash);
  return id ? clone(state.mandates[id]) ?? null : null;
}
export function listMandates() { return clone(Object.values(state.mandates)); }
export function appendDecision(d) {
  const copy = clone(d);
  state.decisions.push(copy);
  if (!byMandate.has(copy.mandateId)) byMandate.set(copy.mandateId, []);
  byMandate.get(copy.mandateId).push(copy);
  persist();
  return d;
}
export function listDecisions() { return clone(state.decisions); }
export function decisionsFor(mandateId) { return clone(byMandate.get(mandateId) || []); }
export function findDecision(id) { return clone(state.decisions.find((d) => d.id === id)); }
export function lastDecision() { return clone(state.decisions[state.decisions.length - 1]); }
export function reset() { state = empty(); reindex(); persist(); }

// Test/demo hook: lets a test simulate an attacker editing the store directly.
export function _tamper(fn) { fn(state); reindex(); }

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
