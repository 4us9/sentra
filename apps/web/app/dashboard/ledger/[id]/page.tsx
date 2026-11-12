'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { DecisionDetail } from '@/components/app/decision-detail';
import { PageHeader } from '@/components/app/shell';
import { Card, CardContent } from '@/components/ui/card';
import { useSentra } from '@/lib/store';

export default function LedgerEntry() {
  const { id } = useParams<{ id: string }>();
  const { decisionById, state } = useSentra();
  const d = decisionById(id);
  return (
    <>
      <Link href="/dashboard/ledger" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"><ChevronLeft className="size-4" /> Ledger</Link>
      <PageHeader title={d ? `Entry #${d.seq}` : 'Entry'} sub={d ? undefined : state ? 'No ledger entry with that id.' : undefined} />
      {d ? <Card className="max-w-3xl"><CardContent className="pt-5"><DecisionDetail d={d} /></CardContent></Card> : null}
    </>
  );
}
