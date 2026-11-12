// Payment processors. The policy engine knows nothing about any of them: it decides
// ALLOW / BLOCK / REVIEW, and only then is a processor asked to execute.
//
// A processor is:
//   name                          'paypal' | 'stripe' | ...
//   mode()                        'sandbox' | 'test' | 'simulated'   (never live)
//   createPayment(PaymentRequest) -> PaymentResult
//
// Contract for createPayment:
//   - It must be idempotent on idempotencyKey (the decision id), so a retry can never
//     create a second payment for one decision.
//   - It must read back what the processor recorded and throw if the amount or
//     currency differ from what was approved. `verified: true` means that check passed.
//   - It must refuse to run against a live/production endpoint or key.
//   - It throws on any failure. The guard turns a throw into verdict ERROR and
//     releases the budget reservation; nothing is debited.
import '../env.js';
import crypto from 'crypto';
import { paypal } from './paypal.js';
import { stripe } from './stripe.js';

/**
 * @typedef {Object} PaymentRequest
 * @property {number} amount            major units, at most 2 decimals
 * @property {string} currency          ISO 4217, upper case
 * @property {string} recipient         allowlisted recipient id
 * @property {string} [purpose]
 * @property {string} idempotencyKey    the Sentra decision id
 *
 * @typedef {Object} PaymentResult
 * @property {string} processor
 * @property {string} id                processor-side payment id
 * @property {string} status            processor-side status
 * @property {'sandbox'|'test'|'simulated'} mode
 * @property {boolean} verified         amount and currency were read back and match
 *
 * @typedef {Object} PaymentProcessor
 * @property {string} name
 * @property {string} label
 * @property {() => 'sandbox'|'test'|'simulated'} mode
 * @property {(req: PaymentRequest) => Promise<PaymentResult>} createPayment
 */

/** @type {Record<string, PaymentProcessor>} */
const REGISTRY = { paypal, stripe };

const forcedSimulation = () =>
  process.env.SENTRA_PROCESSOR_MODE === 'simulate' || process.env.PAYPAL_MODE === 'simulate';

// Wraps a processor so that, with no credentials (or when simulation is forced), it
// returns a clearly-labelled simulated result instead of calling out.
/** @param {PaymentProcessor} p @returns {PaymentProcessor} */
function withSimulation(p) {
  const mode = () => (forcedSimulation() ? 'simulated' : p.mode());
  return {
    name: p.name,
    label: p.label,
    mode,
    async createPayment(req) {
      if (mode() !== 'simulated') return p.createPayment(req);
      return {
        processor: p.name,
        id: 'SIM-' + p.name.toUpperCase() + '-' + crypto.randomBytes(5).toString('hex').toUpperCase(),
        status: 'SIMULATED',
        mode: 'simulated',
        verified: true,
      };
    },
  };
}

const WRAPPED = Object.fromEntries(Object.entries(REGISTRY).map(([k, p]) => [k, withSimulation(p)]));

export const processorNames = () => Object.keys(WRAPPED);
export const isProcessor = (name) => Object.prototype.hasOwnProperty.call(WRAPPED, name);

export function defaultProcessorName() {
  const want = String(process.env.SENTRA_PROCESSOR || 'paypal').toLowerCase();
  return isProcessor(want) ? want : 'paypal';
}

/** @param {string} [name] @returns {PaymentProcessor} */
export function getProcessor(name) {
  const p = WRAPPED[name || defaultProcessorName()];
  if (!p) throw new Error(`unknown processor: ${name}`);
  return p;
}

export function processorStatus() {
  return processorNames().map((name) => ({ name, label: WRAPPED[name].label, mode: WRAPPED[name].mode(), default: name === defaultProcessorName() }));
}
