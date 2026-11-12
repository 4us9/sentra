// Policy-as-config. Policies are JSON files (the service loads them from disk),
// validated against the rules in policies/policy.schema.json. A mandate is
// one issued, sealed instance of a policy: teams review and version the policy
// file; nobody edits limits in code.
//
// The validator is hand-written (a dozen fields) rather than a JSON-Schema library,
// to keep the firewall's dependency surface near zero. It is strict: unknown keys
// are errors, so a typo like "perTxcap" cannot silently fall back to a default.
import { isKnownProcessor } from '../context.js';
import type { MandateInput, Policy } from '../types.js';

export const POLICY_VERSION = 1;
const KNOWN = new Set(['$schema', 'version', 'name', 'description', 'currency', 'processor', 'budgetTotal', 'perTxCap',
  'allowedRecipients', 'scope', 'outOfScope', 'velocityLimit', 'breaker', 'ttlHours']);
const RECIPIENT = /^[A-Za-z0-9_.@:+-]{1,128}$/;

const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isPosInt = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

/** Returns problems; empty when the policy is valid. */
export function validatePolicy(p: unknown): string[] {
  const e: string[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['policy must be a JSON object'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = p as Record<string, any>;
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) e.push(`unknown field "${k}"`);
  if (o.version !== POLICY_VERSION) e.push(`version must be ${POLICY_VERSION}`);
  if (typeof o.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) e.push('name must be lower-case letters, digits and dashes');
  if (typeof o.description !== 'string' || !o.description.trim() || o.description.length > 400) e.push('description must be 1-400 characters');
  if (o.currency !== undefined && !(typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency))) e.push('currency must be a 3-letter ISO code');
  if (o.processor !== undefined && !isKnownProcessor(o.processor)) e.push(`unknown processor "${o.processor}"`);
  if (!isPos(o.budgetTotal)) e.push('budgetTotal must be a positive number');
  if (!isPos(o.perTxCap)) e.push('perTxCap must be a positive number');
  if (isPos(o.budgetTotal) && isPos(o.perTxCap) && o.perTxCap > o.budgetTotal) e.push('perTxCap cannot exceed budgetTotal');
  if (!Array.isArray(o.allowedRecipients) || o.allowedRecipients.length === 0) e.push('allowedRecipients must be a non-empty list');
  else if (o.allowedRecipients.some((r: unknown) => typeof r !== 'string' || !RECIPIENT.test(r))) e.push('allowedRecipients contains an invalid id');
  else if (new Set(o.allowedRecipients).size !== o.allowedRecipients.length) e.push('allowedRecipients contains duplicates');
  if (o.scope !== undefined && !(Array.isArray(o.scope) && o.scope.every((w: unknown) => typeof w === 'string' && w.length >= 2 && w.length <= 40))) e.push('scope must be a list of words');
  if (o.outOfScope !== undefined && !['review', 'block'].includes(o.outOfScope)) e.push('outOfScope must be "review" or "block"');
  for (const [key, a, b] of [['velocityLimit', 'count', 'windowSec'], ['breaker', 'blocks', 'windowSec']] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (!v || typeof v !== 'object' || !isPosInt(v[a]) || !isPosInt(v[b]) || Object.keys(v).length !== 2) e.push(`${key} must be { ${a}, ${b} } with positive integers`);
  }
  if (o.ttlHours !== undefined && !(isPos(o.ttlHours) && o.ttlHours <= 8760)) e.push('ttlHours must be between 0 and 8760');
  return e;
}

/** Turn a valid policy into the fields createMandate() takes. */
export function mandateFromPolicy(policy: Policy, now: number = Date.now()): MandateInput {
  const { $schema: _s, version: _v, name, ttlHours = 24, ...fields } = policy;
  return { ...fields, policy: name, expiresAt: new Date(now + ttlHours * 3600 * 1000).toISOString() };
}
