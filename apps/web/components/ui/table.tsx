import * as React from 'react';
import { cn } from '@/lib/utils';

export const Table = ({ className, ...p }: React.HTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto"><table className={cn('w-full caption-bottom text-[13px]', className)} {...p} /></div>
);
export const TableHeader = ({ className, ...p }: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className={cn('border-b border-line', className)} {...p} />;
export const TableBody = ({ className, ...p }: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody className={className} {...p} />;
export const TableRow = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('border-b border-line/70 transition-colors', className)} {...p} />;
export const TableHead = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-9 whitespace-nowrap px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wider text-faint', className)} {...p} />
);
export const TableCell = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn('px-3 py-2 align-middle', className)} {...p} />;
