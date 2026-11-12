'use client';
import * as React from 'react';
import { getPolicies, getScenarios, getState, agentTokenFor } from './api';
import type { Decision, Mandate, Policy, Scenario, ServiceState } from './types';

const POLL_MS = 2000;

interface Ctx {
  state: ServiceState | null;
  /** null until the first success; string once the service has been unreachable. */
  error: string | null;
  updatedAt: number | null;
  policies: Policy[];
  defaultPolicy: string | null;
  scenarios: Scenario[];
  poisoned: string;
  refresh: () => Promise<void>;
  selectedMandateId: string | null;
  selectMandate: (id: string) => void;
  /** Selected mandate, falling back to the newest one. */
  currentMandate: Mandate | null;
  decisionById: (id: string) => Decision | undefined;
  /** Bumped when agent tokens in sessionStorage change. */
  tokenRev: number;
  bumpTokens: () => void;
}

const SentraCtx = React.createContext<Ctx | null>(null);

export function useSentra(): Ctx {
  const c = React.useContext(SentraCtx);
  if (!c) throw new Error('useSentra outside SentraProvider');
  return c;
}

export function SentraProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ServiceState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);
  const [policies, setPolicies] = React.useState<Policy[]>([]);
  const [defaultPolicy, setDefaultPolicy] = React.useState<string | null>(null);
  const [scenarios, setScenarios] = React.useState<Scenario[]>([]);
  const [poisoned, setPoisoned] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tokenRev, setTokenRev] = React.useState(0);
  const inflight = React.useRef(false);
  const loadedStatic = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const s = await getState();
      if (!Array.isArray(s.mandates) || !Array.isArray(s.decisions)) throw new Error('unexpected state shape');
      setState(s);
      setError(null);
      setUpdatedAt(Date.now());
      if (!loadedStatic.current) {
        loadedStatic.current = true;
        getPolicies().then((p) => { setPolicies(Array.isArray(p.policies) ? p.policies : []); setDefaultPolicy(typeof p.default === 'string' ? p.default : null); }).catch(() => { loadedStatic.current = false; });
        getScenarios().then((r) => { setScenarios(Array.isArray(r.scenarios) ? r.scenarios : []); setPoisoned(typeof r.poisonedListing === 'string' ? r.poisonedListing : ''); }).catch(() => { loadedStatic.current = false; });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unreachable');
    } finally {
      inflight.current = false;
    }
  }, []);

  React.useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVis = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  const currentMandate = React.useMemo(() => {
    const ms = state?.mandates ?? [];
    if (!ms.length) return null;
    const found = ms.find((m) => m.id === selected);
    if (found) return found;
    return ms.reduce((a, b) => (String(b.createdAt) > String(a.createdAt) ? b : a));
  }, [state, selected]);

  const decisionById = React.useCallback((id: string) => state?.decisions.find((d) => d.id === id), [state]);

  const value = React.useMemo<Ctx>(() => ({
    state, error, updatedAt, policies, defaultPolicy, scenarios, poisoned, refresh,
    selectedMandateId: selected, selectMandate: setSelected, currentMandate, decisionById,
    tokenRev, bumpTokens: () => setTokenRev((n) => n + 1),
  }), [state, error, updatedAt, policies, defaultPolicy, scenarios, poisoned, refresh, selected, currentMandate, decisionById, tokenRev]);

  return <SentraCtx.Provider value={value}>{children}</SentraCtx.Provider>;
}

export function useHasAgentToken(mandateId: string | undefined): boolean {
  const { tokenRev } = useSentra();
  return React.useMemo(() => Boolean(mandateId && agentTokenFor(mandateId)), [mandateId, tokenRev]); // eslint-disable-line react-hooks/exhaustive-deps
}
