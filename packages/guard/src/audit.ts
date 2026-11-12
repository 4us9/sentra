// Tamper-evident audit ledger. Every entry carries the hash of the one before it,
// so editing or deleting any past decision breaks every hash after it.
import crypto from 'node:crypto';
import type { ChainStatus } from './types.js';

export const GENESIS = '0'.repeat(64);

// Deterministic JSON: keys sorted at every level, so the same entry always hashes the same.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return '{' + Object.keys(o).sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

export function chainEntry<T extends object>(
  entry: T & { hash?: unknown; prevHash?: unknown },
  prevHash: string = GENESIS,
): Omit<T, 'hash' | 'prevHash'> & { prevHash: string; hash: string } {
  const { hash: _h, prevHash: _p, ...body } = entry;
  return { ...body, prevHash, hash: sha256(prevHash + canonical(body)) } as Omit<T, 'hash' | 'prevHash'> & { prevHash: string; hash: string };
}

export function verifyChain(entries: Array<{ hash: string; prevHash: string; id?: string }>): ChainStatus {
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
