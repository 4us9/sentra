import * as React from 'react';
import { cn } from '@/lib/utils';

const field = 'w-full rounded-md border border-line-strong bg-background px-3 text-sm text-foreground placeholder:text-faint focus-visible:border-accent disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, 'h-9', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-20 py-2', className)} {...props} />
));
Textarea.displayName = 'Textarea';
