// Deterministic hijack signatures for the purpose text. Always on, free, and final:
// no model can talk a hit back down.
//
// The scan runs on a normalised copy so that fullwidth letters, invisible characters
// and look-alike alphabets cannot be used to slip a phrase past the patterns. NFKC
// folds compatibility forms; hidden characters, and any single word that mixes
// alphabets, are themselves treated as hostile.

const any = (parts) => new RegExp(parts.join('|'), 'i');

// Language aimed at a reviewer or a model, pressure, secrecy, or claims of prior
// approval. None of it belongs in the description of a purchase.
const INJECTION = any([
  '\\b(ignore|disregard|forget|bypass)\\b.{0,40}\\b(previous|prior|above|earlier|all|any|the|these|those)\\b',
  '\\b(ignora|ignorez|ignoriere|ignorar|ignorer)\\b',
  'system\\s*(override|prompt|message|:)', '\\boverride\\b',
  '<\\|', '\\bim_(start|end)\\b', '\\[\\[?\\s*(admin|system)',
  'developer mode', 'jailbreak', 'new instructions',
  'as instructed', 'per (the )?instructions?', 'instructions? (in|from|on|above|below)',
  '\\breviewer\\b', '\\bclassif(y|ied|ication)\\b', 'in_scope|out_of_scope', '"(category|risk|verdict)"',
  'pre-?(approved|authori[sz]ed)', 'already (been )?(approved|authori[sz]ed)', 'no (review|approval) (needed|required)',
  'approve this', 'you are now', 'limits? (are |is )?(disabled|lifted|removed|off)',
  'do not (tell|alert|notify|inform)', "don'?t (tell|alert|notify|inform)",
  '\\burgent(ly)?\\b', '\\bimmediately\\b', 'verif(y|ication)',
  'account .{0,30}(lock|suspend|clos|block)',
  // A purchase description has no reason to carry a link, a formula or markup.
  'https?://', '\\bwww\\.', '^\\s*[=@+]', '<\\s*(script|img|iframe|svg|a)\\b',
]);

// Ways of turning a purchase into cash, or into value for someone else.
const CASH_OUT = any([
  'gift ?cards?', 'e-?gift', 'voucher', 'prepaid', 'store credit',
  'top.?up', '\\breload', '(gift|steam|itunes|redeem|card|game) ?codes?', 'send .{0,20}\\bcode\\b',
  '\\b(steam|itunes|google play|playstation|xbox) (card|code|credit)s?',
  'crypto', 'bitcoin', '\\b(btc|eth|usdt|usdc|xmr)\\b', 'stablecoin', 'wallet',
  '\\bwire\\b', '\\btransfers?\\b', 'western union', 'moneygram',
  '\\b(venmo|zelle|cash ?app|revolut)\\b', 'paypal\\.me',
  'money order', 'cash ?back', 'cash ?out', '\\bcash\\b', '\\batm\\b', 'withdraw',
  'lottery', 'scratch ?cards?', 'casino', 'gambl', '\\bbet(s|ting)?\\b',
]);

// Zero-width, soft-hyphen, bidi-control and other invisible code points.
const HIDDEN = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/;
const LATIN = /[A-Za-z]/;
const LOOKALIKE_SCRIPTS = /[Ͱ-ϿЀ-ԯ]/;      // Greek, Cyrillic

/**
 * @param {{ purpose?: string }} request
 * @returns {{ risk: 'low' | 'high', reason: string }}
 */
export function signatureScan(request) {
  const raw = String(request.purpose || '');
  if (HIDDEN.test(raw)) return { risk: 'high', reason: 'purpose contains hidden or direction-control characters' };
  const text = raw.normalize('NFKC');
  const mixed = text.split(/[^\p{L}]+/u).find((w) => LATIN.test(w) && LOOKALIKE_SCRIPTS.test(w));
  if (mixed) return { risk: 'high', reason: `purpose contains a word that mixes alphabets ("${mixed}")` };
  const inj = text.match(INJECTION);
  if (inj) return { risk: 'high', reason: `purpose contains hijack language ("${inj[0]}")` };
  const cash = text.match(CASH_OUT);
  if (cash) return { risk: 'high', reason: `purpose names a cash-out instrument ("${cash[0]}")` };
  return { risk: 'low', reason: 'no hijack signatures' };
}
