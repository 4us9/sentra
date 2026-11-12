// Injected configuration for the pure engine. The engine does no I/O and reads no
// environment: whoever embeds it (the service, a test) says where the signing secret
// comes from, which processor names exist, and which semantic reviewer to use.
//
// Defaults are safe: no secret configured means sealing throws (nothing is ever
// sealed or verified with a guessed key), and the semantic reviewer is the offline
// vocabulary fallback.
import type { SemanticFn } from './types.js';
import { vocabularyFallback } from './intent.js';

export interface GuardOptions {
  /** Returns the HMAC key that seals mandates. Called on every seal/verify. */
  secret?: () => string;
  /** Names of the processors a mandate may be routed to. */
  processors?: string[];
  /** Processor used when a mandate does not name one. */
  defaultProcessor?: string;
  /** Layer-3 semantic reviewer used when a caller does not pass one. */
  semantic?: SemanticFn;
}

const DEFAULT_PROCESSORS = ['paypal', 'stripe', 'external'];
const DEFAULT_PROCESSOR = 'paypal';

const noSecret = (): string => { throw new Error('Sentra guard: no secret configured'); };
const defaultSemantic: SemanticFn = async ({ mandate, request }) => vocabularyFallback({ mandate, request });

let secretFn: () => string = noSecret;
let processorList: string[] = [...DEFAULT_PROCESSORS];
let defaultProcessorName: string = DEFAULT_PROCESSOR;
let semanticFn: SemanticFn = defaultSemantic;

export function configureGuard(opts: GuardOptions): void {
  if (opts.secret !== undefined) secretFn = opts.secret;
  if (opts.processors !== undefined) processorList = [...opts.processors];
  if (opts.defaultProcessor !== undefined) defaultProcessorName = opts.defaultProcessor;
  if (opts.semantic !== undefined) semanticFn = opts.semantic;
}

/** Back to the defaults. For tests. */
export function resetGuardConfig(): void {
  secretFn = noSecret;
  processorList = [...DEFAULT_PROCESSORS];
  defaultProcessorName = DEFAULT_PROCESSOR;
  semanticFn = defaultSemantic;
}

export const guardSecret = (): string => secretFn();
export const guardProcessors = (): readonly string[] => processorList;
export const guardDefaultProcessor = (): string => defaultProcessorName;
export const guardSemantic = (): SemanticFn => semanticFn;
export const isKnownProcessor = (name: unknown): boolean => processorList.includes(String(name));
