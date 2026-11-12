// Runs before every test file. Tests are offline: no model, no processor, no .env.
process.env.SENTRA_NO_DOTENV = '1';
process.env.SENTRA_PROCESSOR_MODE = 'simulate';
process.env.SENTRA_LOG = 'off';
process.env.SENTRA_SECRET = 'test-secret';
process.env.SENTRA_NO_LISTEN = '1';
for (const k of [
  'ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'STRIPE_SECRET_KEY',
  'SENTRA_ADMIN_TOKEN', 'DATABASE_URL', 'SENTRA_RATE_LIMIT',
]) delete process.env[k];

// Dynamic imports so the env above is in place before any service module loads.
const { configureGuard } = await import('@sentra/guard');
const { processorNames, defaultProcessorName } = await import('../src/processors/index.js');
configureGuard({ secret: () => 'test-secret', processors: processorNames(), defaultProcessor: defaultProcessorName() });
