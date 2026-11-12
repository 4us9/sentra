// Policy-as-config. Policies are JSON files in policies/ (or SENTRA_POLICY_DIR),
// validated on load against the rules in policies/policy.schema.json. A mandate is
// one issued, sealed instance of a policy: teams review and version the policy
// file; nobody edits limits in code.
//
// The validator is hand-written (a dozen fields) rather than a JSON-Schema library,
// to keep the firewall's dependency surface near zero. It is strict: unknown keys
// are errors, so a typo like "perTxcap" cannot silently fall back to a default.
import fs from 'fs';
import path from 'path';
import { isProcessor } from '../processors/index.js';

export const POLICY_VERSION = 1;
const KNOWN = new Set(['$schema', 'version', 'name', 'description', 'currency', 'processor', 'budgetTotal', 'perTxCap',
  'allowedRecipients', 'scope', 'outOfScope', 'velocityLimit', 'breaker', 'ttlHours']);
const RECIPIENT = /^[A-Za-z0-9_.@:+-]{1,128}$/;

const isPos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isPosInt = (n) => Number.isInteger(n) && n > 0;

/**
 * @param {unknown} p
 * @returns {string[]} problems; empty when the policy is valid
 */
export function validatePolicy(p) {
  const e = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['policy must be a JSON object'];
  const o = /** @type {Record<string, any>} */ (p);
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) e.push(`unknown field "${k}"`);
  if (o.version !== POLICY_VERSION) e.push(`version must be ${POLICY_VERSION}`);
  if (typeof o.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) e.push('name must be lower-case letters, digits and dashes');
  if (typeof o.description !== 'string' || !o.description.trim() || o.description.length > 400) e.push('description must be 1-400 characters');
  if (o.currency !== undefined && !(typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency))) e.push('currency must be a 3-letter ISO code');
  if (o.processor !== undefined && !isProcessor(o.processor)) e.push(`unknown processor "${o.processor}"`);
  if (!isPos(o.budgetTotal)) e.push('budgetTotal must be a positive number');
  if (!isPos(o.perTxCap)) e.push('perTxCap must be a positive number');
  if (isPos(o.budgetTotal) && isPos(o.perTxCap) && o.perTxCap > o.budgetTotal) e.push('perTxCap cannot exceed budgetTotal');
  if (!Array.isArray(o.allowedRecipients) || o.allowedRecipients.length === 0) e.push('allowedRecipients must be a non-empty list');
  else if (o.allowedRecipients.some((r) => typeof r !== 'string' || !RECIPIENT.test(r))) e.push('allowedRecipients contains an invalid id');
  else if (new Set(o.allowedRecipients).size !== o.allowedRecipients.length) e.push('allowedRecipients contains duplicates');
  if (o.scope !== undefined && !(Array.isArray(o.scope) && o.scope.every((w) => typeof w === 'string' && w.length >= 2 && w.length <= 40))) e.push('scope must be a list of words');
  if (o.outOfScope !== undefined && !['review', 'block'].includes(o.outOfScope)) e.push('outOfScope must be "review" or "block"');
  for (const [key, a, b] of [['velocityLimit', 'count', 'windowSec'], ['breaker', 'blocks', 'windowSec']]) {
    const v = o[key];
    if (v === undefined) continue;
    if (!v || typeof v !== 'object' || !isPosInt(v[a]) || !isPosInt(v[b]) || Object.keys(v).length !== 2) e.push(`${key} must be { ${a}, ${b} } with positive integers`);
  }
  if (o.ttlHours !== undefined && !(isPos(o.ttlHours) && o.ttlHours <= 8760)) e.push('ttlHours must be between 0 and 8760');
  return e;
}

/** Turn a valid policy into the fields createMandate() takes. */
export function mandateFromPolicy(policy, now = Date.now()) {
  const { $schema: _s, version: _v, name, ttlHours = 24, ...fields } = policy;
  return { ...fields, policy: name, expiresAt: new Date(now + ttlHours * 3600 * 1000).toISOString() };
}

const dir = () => path.resolve(process.env.SENTRA_POLICY_DIR || 'policies');

/** Load and validate every policy file. Throws on the first invalid one: a bad policy must not start the server. */
export function loadPolicies(from = dir()) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!fs.existsSync(from)) return out;
  for (const f of fs.readdirSync(from).filter((n) => n.endsWith('.json') && !n.endsWith('.schema.json')).sort()) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(from, f), 'utf8')); }
    catch (err) { throw new Error(`policies/${f}: not valid JSON (${err.message})`); }
    const problems = validatePolicy(parsed);
    if (problems.length) throw new Error(`policies/${f}: ${problems.join('; ')}`);
    if (out[parsed.name]) throw new Error(`policies/${f}: duplicate policy name "${parsed.name}"`);
    out[parsed.name] = parsed;
  }
  return out;
}
