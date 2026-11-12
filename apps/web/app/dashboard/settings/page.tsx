'use client';
import * as React from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/app/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { agentTokenIds, dropAgentTokens, operatorToken, setOperatorToken } from '@/lib/api';
import { API_BASE } from '@/lib/env';
import { useSentra } from '@/lib/store';
import { useToast } from '@/lib/toast';

export default function Settings() {
  const { state, bumpTokens } = useSentra();
  const toast = useToast();
  const [token, setToken] = React.useState('');
  const [stored, setStored] = React.useState(false);
  const [held, setHeld] = React.useState(0);
  React.useEffect(() => { setStored(Boolean(operatorToken())); setHeld(agentTokenIds().length); }, []);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid max-w-3xl gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Operator token</CardTitle>
            <CardDescription>Needed only when the service runs with <code className="font-mono text-foreground">SENTRA_ADMIN_TOKEN</code>. It is sent as the <code className="font-mono text-foreground">x-sentra-admin</code> header on operator actions and kept in this tab&apos;s sessionStorage, never in a URL.{' '}
              {state ? <>This service reports operator auth <Badge tone={state.config.operatorAuth ? 'allow' : 'review'}>{state.config.operatorAuth ? 'required' : 'off (demo)'}</Badge>.</> : null}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (!token.trim()) return; setOperatorToken(token.trim()); setToken(''); setStored(true); toast('Operator token saved for this tab.', true); }}>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="op">Token {stored ? <Badge tone="allow" className="ml-1">set</Badge> : null}</Label>
                <Input id="op" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={stored ? 'Enter a new token to replace it' : 'SENTRA_ADMIN_TOKEN'} />
              </div>
              <Button type="submit" disabled={!token.trim()}><KeyRound /> Save</Button>
              <Button type="button" variant="outline" disabled={!stored} onClick={() => { setOperatorToken(''); setStored(false); toast('Operator token cleared.', true); }}>Clear</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent tokens held in this tab</CardTitle>
            <CardDescription>Returned once when a mandate is issued and used by the Attack Lab to act as the agent. They live only in this tab&apos;s sessionStorage.</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <span className="text-sm text-muted">{held} held</span>
            <Button variant="outline" size="sm" disabled={!held} onClick={() => { dropAgentTokens(); setHeld(0); bumpTokens(); toast('Agent tokens dropped from this tab.', true); }}><Trash2 /> Drop all</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API keys</CardTitle>
            <CardDescription>Per-tenant API keys arrive with the Postgres backend (tenant isolation, per-operator auth). Until then a single shared operator token guards a single-tenant service, and there is nothing to create here.</CardDescription>
          </CardHeader>
          <CardContent><Button variant="outline" disabled>Create API key (not available yet)</Button></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-[13px] text-muted">
            <p>Guard service: <code className="font-mono text-foreground">{API_BASE}</code> <span className="text-faint">(NEXT_PUBLIC_SENTRA_API)</span></p>
            <p>Polling every 2 seconds while this tab is visible.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
