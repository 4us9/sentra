// Operator authentication.
//
//   SENTRA_ADMIN_TOKEN unset, no API keys   open demo mode (anyone may operate)
//   SENTRA_ADMIN_TOKEN set                  root credential, sent as x-sentra-admin
//   API keys (sk_sentra_...)                per-operator, scoped, hashed at rest,
//                                           sent as x-sentra-admin or Authorization: Bearer
//
// API keys can only be minted with the root credential, so an open demo can never
// be locked by whoever mints the first key. Agent tokens (sat_...) are never
// accepted here: an agent is not an operator.
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyRecord, Store } from '@sentra/db';
import { hashToken } from '@sentra/guard';

export type Scope = 'admin' | 'read';
export interface Operator { id: string; label: string; scopes: Scope[]; root: boolean }

const rootToken = () => process.env.SENTRA_ADMIN_TOKEN || '';
const presented = (req: FastifyRequest): string => {
  const h = req.headers['x-sentra-admin'];
  if (typeof h === 'string' && h) return h;
  const b = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return b.startsWith('sk_sentra_') ? b : '';
};
const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function operatorAuthEnabled(store: Store): boolean {
  return Boolean(rootToken()) || store.listApiKeys().some((k) => !k.revokedAt);
}

export function identify(store: Store, req: FastifyRequest): Operator | null {
  const got = presented(req);
  if (!got) return null;
  if (rootToken() && equal(got, rootToken())) return { id: 'root', label: 'root', scopes: ['admin', 'read'], root: true };
  const k = store.apiKeyByHash(hashToken(got));
  if (!k || k.revokedAt) return null;
  return { id: k.id, label: k.label, scopes: k.scopes, root: false };
}

/** A Fastify preHandler requiring `scope`. Attaches req.operator. */
export function requireOperator(store: Store, scope: Scope, opts: { rootOnly?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.rootOnly && !rootToken()) {
      return reply.code(403).send({ error: 'set SENTRA_ADMIN_TOKEN to manage API keys' });
    }
    if (!operatorAuthEnabled(store)) {
      (req as FastifyRequest & { operator?: Operator }).operator = { id: 'demo', label: 'operator', scopes: ['admin', 'read'], root: false };
      return;
    }
    const op = identify(store, req);
    if (!op) return reply.code(401).send({ error: 'operator token required' });
    if (!op.scopes.includes(scope) || (opts.rootOnly && !op.root)) return reply.code(403).send({ error: `this key lacks the ${scope} scope` });
    (req as FastifyRequest & { operator?: Operator }).operator = op;
  };
}

export const operatorOf = (req: FastifyRequest): Operator =>
  (req as FastifyRequest & { operator?: Operator }).operator || { id: 'demo', label: 'operator', scopes: ['admin', 'read'], root: false };

export function mintApiKey(store: Store, label: string, scopes: Scope[]): { key: string; record: Omit<ApiKeyRecord, 'keyHash'> } {
  const key = 'sk_sentra_' + crypto.randomBytes(24).toString('base64url');
  const record: ApiKeyRecord = {
    id: 'key_' + crypto.randomBytes(6).toString('hex'),
    tenantId: 'default',
    keyHash: hashToken(key),
    label: label.slice(0, 64) || 'operator',
    scopes,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  store.saveApiKey(record);
  const { keyHash: _h, ...pub } = record;
  return { key, record: pub };
}
