// Layer 0: schema. A request that is not a well-formed payment never reaches the
// rules, the model, or PayPal. This is where the cheap tricks die: negative amounts
// (to "refund" budget back), fractional cents (salami slicing), NaN/Infinity,
// look-alike Unicode recipient ids, oversized or control-character payloads.
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;
const RECIPIENT = /^[A-Za-z0-9_.@:+-]{1,128}$/;
const CURRENCY = /^[A-Z]{3}$/;

export const toCents = (n) => Math.round(Number(n) * 100);

export function validateRequest(raw, mandate) {
  const errors = [];
  const r = raw && typeof raw === 'object' ? raw : {};

  let amount = null;
  const a = r.amount;
  const asText = typeof a === 'number' ? String(a) : typeof a === 'string' ? a.trim() : null;
  if (asText === null || !AMOUNT.test(asText)) {
    errors.push({ check: 'amount_format', detail: `amount ${JSON.stringify(a ?? null)} is not a positive money value with at most 2 decimals` });
  } else if (toCents(asText) <= 0) {
    errors.push({ check: 'amount_format', detail: 'amount must be greater than zero' });
  } else {
    amount = toCents(asText) / 100;
  }

  const currency = r.currency === undefined ? mandate.currency : String(r.currency).toUpperCase();
  if (!CURRENCY.test(currency)) errors.push({ check: 'currency_format', detail: 'currency must be a 3-letter ISO code' });

  const recipient = typeof r.recipient === 'string' ? r.recipient : '';
  if (!RECIPIENT.test(recipient)) {
    const nonAscii = /[^\x00-\x7F]/.test(recipient);
    errors.push({
      check: 'recipient_format',
      detail: nonAscii
        ? 'recipient contains non-ASCII characters (look-alike / homoglyph id)'
        : 'recipient must be 1-128 chars of [A-Za-z0-9_.@:+-]',
    });
  }

  let purpose = r.purpose === undefined || r.purpose === null ? '' : r.purpose;
  if (typeof purpose !== 'string') { errors.push({ check: 'purpose_format', detail: 'purpose must be text' }); purpose = ''; }
  if (purpose.length > 500) errors.push({ check: 'purpose_format', detail: 'purpose longer than 500 chars' });
  purpose = purpose.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 500);

  let idempotencyKey = null;
  if (r.idempotencyKey !== undefined && r.idempotencyKey !== null) {
    if (typeof r.idempotencyKey !== 'string' || !/^[\w.:-]{1,100}$/.test(r.idempotencyKey)) {
      errors.push({ check: 'idempotency_format', detail: 'idempotencyKey must be 1-100 chars of [A-Za-z0-9_.:-]' });
    } else idempotencyKey = r.idempotencyKey;
  }

  return {
    ok: errors.length === 0,
    errors,
    // Safe-to-store echo of what was asked for (never trusted, only displayed).
    request: {
      amount: amount ?? (typeof a === 'number' && Number.isFinite(a) ? a : String(a ?? '').slice(0, 40)),
      currency: CURRENCY.test(currency) ? currency : String(currency).slice(0, 8),
      recipient: String(recipient || r.recipient || '').replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 128),
      purpose,
      idempotencyKey,
    },
  };
}
