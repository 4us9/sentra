// In-memory state with atomic write-through to data/db.json (tmp file + rename),
// so a crash mid-write can never leave a half-written ledger.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const dir = path.resolve(process.env.SENTRA_DATA_DIR || 'data');
const file = path.join(dir, 'db.json');
const secretFile = path.join(dir, 'secret.key');

/**
 * @typedef {import('./types.js').Mandate} Mandate
 * @typedef {import('./types.js').Decision} Decision
 * @typedef {import('./types.js').StoreState} StoreState
 */

/** @returns {StoreState} */
const empty = () => ({ mandates: {}, decisions: [] });
let state = load();

/** @returns {StoreState} */
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

/**
 * @template T
 * @param {T} x
 * @returns {T}
 */
const clone = (x) => /** @type {T} */ (x === undefined ? undefined : structuredClone(x));

// Indexes, rebuilt from state whenever it is replaced. They keep the hot path
// (one /guard call) from scanning every mandate and every decision ever made.
/** @type {Map<string, string>} */
let byToken = new Map();        // tokenHash -> mandateId
/** @type {Map<string, Decision[]>} */
let byMandate = new Map();      // mandateId -> decisions[] (same objects as state.decisions)
function reindex() {
  byToken = new Map(Object.values(state.mandates).map((m) => [m.tokenHash, m.id]));
  byMandate = new Map();
  for (const d of state.decisions) {
    if (!byMandate.has(d.mandateId)) byMandate.set(d.mandateId, []);
    /** @type {Decision[]} */ (byMandate.get(d.mandateId)).push(d);
  }
}
reindex();

/**
 * @param {Mandate} m
 * @returns {Mandate}
 */
export function saveMandate(m) {
  state.mandates[m.id] = clone(m);
  byToken.set(m.tokenHash, m.id);
  persist();
  return m;
}
/**
 * @param {string} id
 * @returns {Mandate | undefined}
 */
export function getMandate(id) { return clone(state.mandates[id]); }
/**
 * @param {string} hash
 * @returns {Mandate | null}
 */
export function mandateByTokenHash(hash) {
  const id = byToken.get(hash);
  return id ? clone(state.mandates[id]) ?? null : null;
}
/** @returns {Mandate[]} */
export function listMandates() { return clone(Object.values(state.mandates)); }
/**
 * @param {Decision} d
 * @returns {Decision}
 */
export function appendDecision(d) {
  const copy = clone(d);
  state.decisions.push(copy);
  if (!byMandate.has(copy.mandateId)) byMandate.set(copy.mandateId, []);
  /** @type {Decision[]} */ (byMandate.get(copy.mandateId)).push(copy);
  persist();
  return d;
}
/** @returns {Decision[]} */
export function listDecisions() { return clone(state.decisions); }
/**
 * @param {string} mandateId
 * @returns {Decision[]}
 */
export function decisionsFor(mandateId) { return clone(byMandate.get(mandateId) || []); }
/**
 * @param {string} id
 * @returns {Decision | undefined}
 */
export function findDecision(id) { return clone(state.decisions.find((d) => d.id === id)); }
/** @returns {Decision | undefined} */
export function lastDecision() { return clone(state.decisions[state.decisions.length - 1]); }
export function reset() { state = empty(); reindex(); persist(); }

// Test/demo hook: lets a test simulate an attacker editing the store directly.
/** @param {(state: StoreState) => void} fn */
export function _tamper(fn) { fn(state); reindex(); }

// Server secret used to seal mandates. Env wins; otherwise generated once and kept
// next to the data so seals survive a restart.
/** @type {string | null} */
let cachedSecret = null;
/** @returns {string} */
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
