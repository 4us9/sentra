// Payment processors. The policy engine knows nothing about any of them: it decides
// ALLOW / BLOCK / REVIEW, and only then is a processor asked to execute.
//
// Contract for createPayment (see docs/ADDING_A_PROCESSOR.md):
//   - idempotent on idempotencyKey (the decision id): a retry never pays twice
//   - reads back what the processor recorded and throws if amount or currency differ
//   - refuses to run against a live/production endpoint or key
//   - throws on any failure; the guard turns that into ERROR and releases the budget
import '../env.js';
import crypto from 'node:crypto';
import type { PaymentProcessor, ProcessorMode } from '@sentra/guard';
import { paypal } from './paypal.js';
import { stripe } from './stripe.js';

// "external": Sentra authorises and records, the caller executes on its own rail
// (proxy mode, for putting the firewall in front of a payment tool an agent already
// has). Sentra cannot verify what the caller then does, so `verified` is false.
const external: PaymentProcessor = {
  name: 'external',
  label: 'External (authorise only)',
  mode: () => 'external',
  async createPayment({ idempotencyKey }) {
    return { processor: 'external', id: 'AUTH-' + idempotencyKey, status: 'AUTHORIZED', mode: 'external', verified: false };
  },
};

const REGISTRY: Record<string, PaymentProcessor> = { paypal, stripe, external };

const forcedSimulation = () => process.env.SENTRA_PROCESSOR_MODE === 'simulate' || process.env.PAYPAL_MODE === 'simulate';

// With no credentials (or simulation forced) a processor returns a clearly labelled
// simulated result instead of calling out.
function withSimulation(p: PaymentProcessor): PaymentProcessor {
  const mode = (): ProcessorMode => (p.mode() === 'external' ? 'external' : forcedSimulation() ? 'simulated' : p.mode());
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

const WRAPPED: Record<string, PaymentProcessor> = Object.fromEntries(Object.entries(REGISTRY).map(([k, p]) => [k, withSimulation(p)]));

export const processorNames = (): string[] => Object.keys(WRAPPED);
export const isProcessor = (name: unknown): boolean => Object.prototype.hasOwnProperty.call(WRAPPED, String(name));

export function defaultProcessorName(): string {
  const want = String(process.env.SENTRA_PROCESSOR || 'paypal').toLowerCase();
  return isProcessor(want) ? want : 'paypal';
}

export function getProcessor(name?: string): PaymentProcessor {
  const p = WRAPPED[name || defaultProcessorName()];
  if (!p) throw new Error(`unknown processor: ${name}`);
  return p;
}

export function processorStatus() {
  return processorNames().map((name) => ({ name, label: WRAPPED[name].label, mode: WRAPPED[name].mode(), default: name === defaultProcessorName() }));
}
