import type { Metadata } from 'next';
import { CodeBlock } from '@/components/app/code-block';
import { GITHUB_URL } from '@/lib/env';

export const metadata: Metadata = { title: 'Docs' };

const TOC = [
  ['run', 'Run it locally'], ['mandate', 'Issue a mandate'], ['sdk', 'SDK'], ['proxy', 'Proxy a payment tool'],
  ['mcp', 'MCP'], ['policy', 'Policy files'], ['api', 'HTTP API'], ['verdicts', 'Verdicts'], ['limits', 'Honest limits'],
] as const;

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mb-3 mt-14 scroll-mt-20 text-2xl font-semibold tracking-tight first:mt-0">{children}</h2>;
}
const P = ({ children }: { children: React.ReactNode }) => <p className="my-3 max-w-2xl text-[15px] leading-relaxed text-muted">{children}</p>;
const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px] text-foreground">{children}</code>;

export default function Docs() {
  return (
    <div className="mx-auto grid grid-cols-1 [&>*]:min-w-0 max-w-6xl gap-10 px-5 py-14 lg:grid-cols-[200px_1fr]">
      <aside className="hidden lg:block">
        <nav className="sticky top-24 space-y-1 text-[13px]" aria-label="On this page">
          <p className="mb-2 text-xs uppercase tracking-wider text-faint">On this page</p>
          {TOC.map(([id, label]) => <a key={id} href={`#${id}`} className="block rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-foreground">{label}</a>)}
        </nav>
      </aside>
      <article className="min-w-0">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">Docs</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Getting started</h1>
        <P>Sentra is a service plus a thin client. The service holds the processor credentials and decides; the agent holds a token and asks. Everything below runs offline in <strong className="text-foreground">simulated</strong> mode (payment ids start with <C>SIM-</C>) until you add sandbox credentials.</P>

        <H id="run">Run it locally</H>
        <CodeBlock title="terminal">{`pnpm install
pnpm test          # unit, guard, HTTP and adversarial suites; offline
pnpm start         # the guard service
pnpm demo          # in a second terminal: scripted agent, every scenario`}</CodeBlock>
        <P>For real sandboxes, copy <C>.env.example</C> to <C>.env</C>. Sentra refuses to start against a non-sandbox PayPal URL or a live Stripe key.</P>
        <div className="my-4 overflow-hidden rounded-lg border border-line text-[13px]">
          <table className="w-full">
            <thead className="bg-surface text-left text-[11px] uppercase tracking-wider text-faint"><tr><th className="px-4 py-2">Rail</th><th className="px-4 py-2">Variables</th><th className="px-4 py-2">Mode</th></tr></thead>
            <tbody className="divide-y divide-line text-muted">
              <tr><td className="px-4 py-2 text-foreground">PayPal</td><td className="px-4 py-2 font-mono text-xs">PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET</td><td className="px-4 py-2">Orders API v2, sandbox</td></tr>
              <tr><td className="px-4 py-2 text-foreground">Stripe</td><td className="px-4 py-2 font-mono text-xs">STRIPE_SECRET_KEY (sk_test_)</td><td className="px-4 py-2">PaymentIntents, test card</td></tr>
              <tr><td className="px-4 py-2 text-foreground">Claude</td><td className="px-4 py-2 font-mono text-xs">ANTHROPIC_API_KEY (optional)</td><td className="px-4 py-2">intent classification</td></tr>
            </tbody>
          </table>
        </div>

        <H id="mandate">Issue a mandate</H>
        <P>A mandate is what a human authorised: budget, per-payment cap, allowed recipients, velocity, expiry, and the rail that executes an ALLOW. It is sealed with an HMAC over every field, so the agent cannot widen or reroute it. Issue one from the dashboard (Mandates, pick a policy and a processor) or over HTTP. The agent token is returned once.</P>
        <CodeBlock title="terminal">{`curl -s -X POST $SENTRA_URL/api/mandates \\
  -H 'content-type: application/json' \\
  -d '{"policy":"grocery-run","processor":"paypal"}'
# -> { "mandate": { ... }, "agentToken": "sat_..." }   (shown once)`}</CodeBlock>
        <P>If the service has <C>SENTRA_ADMIN_TOKEN</C> set, operator calls need an <C>x-sentra-admin</C> header. Enter it under Settings in the dashboard.</P>

        <H id="sdk">SDK</H>
        <CodeBlock title="agent.ts">{`import { Sentra } from '@sentra/sdk';

const sentra = new Sentra({ url: process.env.SENTRA_URL, agentToken: process.env.SENTRA_AGENT_TOKEN });
const decision = await sentra.guard({ amount: 40, recipient: 'merchant_freshmart', purpose: 'weekly groceries' });
if (decision.verdict === 'ALLOW') console.log(decision.paymentId);`}</CodeBlock>

        <H id="proxy">Proxy a payment tool</H>
        <P>With a mandate whose processor is <C>external</C>, Sentra authorises and records and your tool executes. Wrap the tool you already have:</P>
        <CodeBlock>{`const payWithStripe = sentra.protect((payment) => existingStripeTool(payment));`}</CodeBlock>

        <H id="mcp">MCP</H>
        <P>Any MCP-capable agent gets <C>pay</C> and <C>mandate</C>, and no keys.</P>
        <CodeBlock title="mcp config">{`{ "mcpServers": { "sentra": {
    "command": "node",
    "args": ["/abs/path/sentra/mcp/sentra-mcp.js"],
    "env": { "SENTRA_URL": "http://localhost:4000", "SENTRA_AGENT_TOKEN": "sat_..." }
} } }`}</CodeBlock>

        <H id="policy">Policy files</H>
        <P>A policy is a versioned JSON file in <C>policies/</C>, validated on start. Unknown fields are errors, so a typo cannot silently fall back to a default. A mandate is one issued, sealed instance of a policy.</P>
        <CodeBlock title="policies/grocery-run.json">{`{
  "version": 1,
  "name": "grocery-run",
  "description": "Grocery run. Buy groceries from known merchants only. No transfers, no gift cards.",
  "budgetTotal": 300,
  "perTxCap": 75,
  "allowedRecipients": ["merchant_freshmart", "merchant_greengrocer"],
  "outOfScope": "review",
  "velocityLimit": { "count": 6, "windowSec": 60 },
  "breaker": { "blocks": 5, "windowSec": 120 },
  "ttlHours": 24
}`}</CodeBlock>

        <H id="api">HTTP API</H>
        <div className="my-4 overflow-hidden rounded-lg border border-line text-[13px]">
          <table className="w-full">
            <tbody className="divide-y divide-line text-muted">
              {[
                ['POST /guard', 'Agent. Bearer token. {amount, recipient, purpose, currency?, idempotencyKey?} returns a decision.'],
                ['GET /guard/mandate', 'Agent. What am I allowed to do?'],
                ['POST /api/mandates', 'Operator. {policy?, processor?} returns the mandate and agent token (shown once).'],
                ['POST /api/mandates/:id/freeze | /reinstate', 'Operator. Kill switch.'],
                ['POST /api/reviews/:id/approve | /deny', 'Operator. Resolve a held payment; every rule is re-run at approval.'],
                ['GET /api/ledger', 'Filters: verdict, kind, layer, check, processor, mandate, since, until, q, limit, offset. format=csv exports.'],
                ['GET /api/metrics | /metrics', 'JSON and Prometheus.'],
                ['GET /api/state | /api/policies | /api/audit/verify', 'Dashboard state, loaded policies, hash-chain check.'],
              ].map(([r, d]) => <tr key={r}><td className="whitespace-nowrap px-4 py-2 align-top font-mono text-xs text-foreground">{r}</td><td className="px-4 py-2">{d}</td></tr>)}
            </tbody>
          </table>
        </div>
        <P><C>/guard</C> is rate limited per agent token and operator writes per IP.</P>

        <H id="verdicts">Verdicts</H>
        <ul className="my-3 max-w-2xl space-y-2 text-[15px] leading-relaxed text-muted">
          <li><strong className="text-allow">ALLOW</strong> passed every layer and was executed.</li>
          <li><strong className="text-block">BLOCK</strong> was refused; the processor was never called.</li>
          <li><strong className="text-review">REVIEW</strong> is held until a human approves or denies it.</li>
          <li><strong className="text-error">ERROR</strong> passed the firewall but the processor failed; nothing was debited.</li>
        </ul>

        <H id="limits">Honest limits</H>
        <ul className="my-3 max-w-2xl list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted">
          <li>A PayPal ALLOW creates a sandbox order (status CREATED). Capturing funds needs payer approval, which is PayPal&apos;s own control.</li>
          <li>Recipients are ids on an allowlist, not yet mapped to processor payee accounts.</li>
          <li>Storage is a single instance with in-process locks until the Postgres backend lands.</li>
          <li>The no-model intent fallback is a keyword vocabulary: a floor, not a substitute for the model.</li>
        </ul>
        <P>Full threat model and adapter contract are in the <a className="text-accent underline underline-offset-4" href={GITHUB_URL} rel="noreferrer">repository</a>.</P>
      </article>
    </div>
  );
}
