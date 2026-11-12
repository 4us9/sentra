// Tamper-evident audit ledger. Every entry carries the hash of the one before it,
// so editing or deleting any past decision breaks every hash after it.
import crypto from 'crypto';

export const GENESIS = '0'.repeat(64);

// Deterministic JSON: keys sorted at every level, so the same entry always hashes the same.
/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => /** @type {Record<string, unknown>} */ (value)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(/** @type {Record<string, unknown>} */ (value)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** @param {string} s */
export function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * @template T
 * @param {T & { hash?: unknown, prevHash?: unknown }} entry
 * @param {string} [prevHash]
 * @returns {Omit<T, 'hash' | 'prevHash'> & { prevHash: string, hash: string }}
 */
export function chainEntry(entry, prevHash = GENESIS) {
  const { hash: _h, prevHash: _p, ...body } = entry;
  return { ...body, prevHash, hash: sha256(prevHash + canonical(body)) };
}

/**
 * @param {Array<{ hash: string, prevHash: string, id?: string }>} entries
 * @returns {import('./types.js').ChainStatus}
 */
export function verifyChain(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const { hash, prevHash, ...body } = entries[i];
    if (prevHash !== prev || hash !== sha256(prev + canonical(body))) {
      return { ok: false, length: entries.length, brokenAt: i, brokenId: entries[i].id, head: prev };
    }
    prev = hash;
  }
  return { ok: true, length: entries.length, brokenAt: null, head: prev };
}
