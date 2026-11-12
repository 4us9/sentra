// Claude as the semantic reviewer (layer 3). It classifies; fixed policy in
// @sentra/guard decides what the class means. Anything that goes wrong returns
// null, and the guard falls back to the vocabulary check (never to ALLOW).
import './env.js';
import Anthropic from '@anthropic-ai/sdk';
import { INTENT_SYSTEM_PROMPT, parseVerdict, type SemanticFn } from '@sentra/guard';

export const llmConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);
export const intentModel = (): string => process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

let client: Anthropic | null = null;
const getClient = (): Anthropic => (client ??= new Anthropic({ timeout: 15_000, maxRetries: 1 }));

// Spend guard: a public demo must not be able to run up a model bill.
const HOURLY_CAP = Number(process.env.SENTRA_LLM_HOURLY_CAP || 120);
let calls: number[] = [];
function underCap(): boolean {
  const cutoff = Date.now() - 3600_000;
  calls = calls.filter((t) => t > cutoff);
  if (calls.length >= HOURLY_CAP) return false;
  calls.push(Date.now());
  return true;
}
export const llmCallsLastHour = (): number => calls.filter((t) => t > Date.now() - 3600_000).length;

export const llmSemantic: SemanticFn = async ({ mandate, request }) => {
  if (!llmConfigured() || !underCap()) return null;
  try {
    const response = await getClient().messages.create({
      model: intentModel(),
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: INTENT_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content:
          `<mandate>\n${JSON.stringify({
            description: mandate.description, currency: mandate.currency,
            budgetTotal: mandate.budgetTotal, perTxCap: mandate.perTxCap,
            allowedRecipients: mandate.allowedRecipients,
          }, null, 2)}\n</mandate>\n` +
          `<payment>\n${JSON.stringify({
            amount: request.amount, currency: request.currency,
            recipient: request.recipient, purpose: request.purpose,
          }, null, 2)}\n</payment>`,
      }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    if (response.stop_reason === 'refusal') return { risk: 'med', reason: 'model declined to assess this payment', source: 'llm' };
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    return { ...parseVerdict(text, mandate), source: 'llm' };
  } catch (e) {
    const err = e as { status?: unknown; message?: unknown };
    console.error('[intent] model call failed, using fallback:', err?.status || '', String(err?.message || e).slice(0, 200));
    return null;
  }
};
