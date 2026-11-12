'use client';
import * as React from 'react';
import {
  flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type ColumnFiltersState, type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, ShieldCheck, ShieldX } from 'lucide-react';
import { PageHeader } from '@/components/app/shell';
import { ProcessorTag, VerdictBadge } from '@/components/app/badges';
import { DecisionDetail } from '@/components/app/decision-detail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadLedgerCsv, getAudit } from '@/lib/api';
import { clock, decidingText, isNum, money, str } from '@/lib/format';
import { useSentra } from '@/lib/store';
import { useToast } from '@/lib/toast';
import type { ChainStatus, Decision } from '@/lib/types';
import { cn } from '@/lib/utils';

const VERDICTS = ['ALLOW', 'BLOCK', 'REVIEW', 'ERROR', 'INFO'];
const eq = (row: { getValue: (id: string) => unknown }, id: string, v: string) => row.getValue(id) === v;

export default function LedgerPage() {
  const { state, decisionById } = useSentra();
  const toast = useToast();
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'seq', desc: true }]);
  const [filters, setFilters] = React.useState<ColumnFiltersState>([]);
  const [q, setQ] = React.useState('');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [verified, setVerified] = React.useState<ChainStatus | null>(null);
  const [verifying, setVerifying] = React.useState(false);

  const data = React.useMemo(() => state?.decisions ?? [], [state]);
  const procs = state?.config.processors;

  const columns = React.useMemo<ColumnDef<Decision>[]>(() => [
    { id: 'seq', header: '#', accessorFn: (d) => d.seq, cell: (c) => <span className="font-mono text-faint">{c.getValue<number>()}</span> },
    { id: 'time', header: 'Time', accessorFn: (d) => d.createdAt, cell: (c) => <span className="font-mono">{clock(c.getValue<string>())}</span>, enableSorting: false },
    { id: 'verdict', header: 'Verdict', accessorFn: (d) => d.verdict, cell: (c) => <VerdictBadge verdict={c.getValue<string>()} />, filterFn: (r, id, v) => eq(r, id, v as string) },
    {
      id: 'amount', header: 'Amount', accessorFn: (d) => (isNum(d.request?.amount) ? d.request.amount : -Infinity),
      cell: ({ row }) => {
        const d = row.original; const a = d.request?.amount;
        if (d.kind === 'event') return <span className="text-faint">-</span>;
        return isNum(a) ? <span className={cn('font-mono tabular-nums', a < 0 && 'text-block')}>{money(a, d.request.currency)}</span> : <span className="font-mono text-block">{str(a, 40) || '(none)'}</span>;
      },
    },
    { id: 'recipient', header: 'Recipient', accessorFn: (d) => str(d.request?.recipient, 200), cell: (c) => <span className="block max-w-[200px] truncate font-mono text-[12px]" title={c.getValue<string>()}>{c.getValue<string>() || '-'}</span> },
    { id: 'processor', header: 'Rail', accessorFn: (d) => d.processor, cell: (c) => <ProcessorTag name={c.getValue<string>()} processors={procs} withMode={false} />, filterFn: (r, id, v) => eq(r, id, v as string) },
    { id: 'why', header: 'Decided by', accessorFn: (d) => decidingText(d), cell: (c) => <span className="block max-w-[320px] truncate text-muted" title={c.getValue<string>()}>{c.getValue<string>()}</span>, enableSorting: false },
  ], [procs]);

  const table = useReactTable({
    data, columns,
    state: { sorting, columnFilters: filters, globalFilter: q },
    onSortingChange: setSorting, onColumnFiltersChange: setFilters, onGlobalFilterChange: setQ,
    globalFilterFn: (row, _id, value) => {
      const d = row.original; const s = String(value).toLowerCase();
      return [d.id, d.paymentId, d.request?.recipient, d.request?.purpose, d.mandateId].some((x) => String(x ?? '').toLowerCase().includes(s));
    },
    getCoreRowModel: getCoreRowModel(), getFilteredRowModel: getFilteredRowModel(), getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  });

  const setFilter = (id: string, v: string) => setFilters((f) => [...f.filter((x) => x.id !== id), ...(v === 'all' ? [] : [{ id, value: v }])]);
  const fv = (id: string) => (filters.find((f) => f.id === id)?.value as string | undefined) ?? 'all';
  const open = openId ? decisionById(openId) : undefined;
  const chain = verified ?? state?.audit ?? null;

  async function verify() {
    setVerifying(true);
    try { setVerified(await getAudit()); } catch (e) { toast(`Verification failed: ${e instanceof Error ? e.message : 'error'}`); } finally { setVerifying(false); }
  }

  return (
    <>
      <PageHeader title="Ledger" sub="Append-only and hash-chained. Operator actions and review resolutions are entries too; nothing is ever edited."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {chain ? (
              <Badge tone={chain.ok ? 'allow' : 'block'}>{chain.ok ? <ShieldCheck className="size-3" /> : <ShieldX className="size-3" />}{chain.ok ? `chain verified · ${chain.length}` : `TAMPERED at #${chain.brokenAt}`}</Badge>
            ) : null}
            <Button size="sm" variant="outline" onClick={verify} disabled={verifying}>{verifying ? 'Verifying...' : 'Verify chain'}</Button>
            <Button size="sm" variant="outline" onClick={() => downloadLedgerCsv({ verdict: fv('verdict') === 'all' ? undefined : fv('verdict'), processor: fv('processor') === 'all' ? undefined : fv('processor'), q: q || undefined }).catch((e) => toast(e instanceof Error ? e.message : 'export failed'))}><Download /> CSV</Button>
          </div>
        } />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="w-full sm:w-64" placeholder="Search recipient, purpose, payment id" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="w-36">
          <Select value={fv('verdict')} onValueChange={(v) => setFilter('verdict', v)}>
            <SelectTrigger aria-label="Verdict filter"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All verdicts</SelectItem>{VERDICTS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="w-36">
          <Select value={fv('processor')} onValueChange={(v) => setFilter('processor', v)}>
            <SelectTrigger aria-label="Processor filter"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All rails</SelectItem>{(procs ?? []).map((p) => <SelectItem key={p.name} value={p.name}>{str(p.label || p.name, 30)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <span className="ml-auto text-xs text-faint">{table.getFilteredRowModel().rows.length} of {data.length} entries</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => {
                  const dir = h.column.getIsSorted();
                  return (
                    <TableHead key={h.id} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                      {h.column.getCanSort() ? (
                        <button type="button" onClick={h.column.getToggleSortingHandler()} className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-foreground">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === 'asc' ? <ArrowUp className="size-3" /> : dir === 'desc' ? <ArrowDown className="size-3" /> : null}
                        </button>
                      ) : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? table.getRowModel().rows.map((r) => (
              <TableRow key={r.id} tabIndex={0} role="button" aria-label={`Open entry ${r.original.seq}`}
                className={cn('cursor-pointer hover:bg-surface-2/70', r.original.verdict === 'BLOCK' && 'bg-block/[0.025]')}
                onClick={() => setOpenId(r.original.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(r.original.id); } }}>
                {r.getVisibleCells().map((c) => <TableCell key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</TableCell>)}
              </TableRow>
            )) : <TableRow><TableCell colSpan={columns.length} className="py-10 text-center text-muted">No entries match.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
        <span>Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}</span>
        <Button size="icon" variant="outline" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page"><ChevronLeft /></Button>
        <Button size="icon" variant="outline" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page"><ChevronRight /></Button>
      </div>

      <Sheet open={Boolean(open)} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
        <SheetContent>
          <div className="border-b border-line px-6 py-4 pr-12">
            <SheetTitle className="text-[15px] font-semibold">Ledger entry</SheetTitle>
            <SheetDescription className="text-xs text-faint">Everything below is data from the agent or the service, shown as text.</SheetDescription>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">{open ? <DecisionDetail d={open} linkOut /> : null}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
