'use client';
import * as React from 'react';
import { cn } from './utils';

type Push = (msg: string, ok?: boolean) => void;
const ToastCtx = React.createContext<Push>(() => {});
export const useToast = () => React.useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [t, setT] = React.useState<{ msg: string; ok: boolean; n: number } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const push = React.useCallback<Push>((msg, ok = false) => {
    setT({ msg, ok, n: Date.now() });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), ok ? 3500 : 7000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
        {t ? (
          <div key={t.n} className={cn('pointer-events-auto max-w-lg animate-rise rounded-md border px-4 py-2.5 text-[13px] shadow-xl shadow-black/50', t.ok ? 'border-allow/40 bg-[#0d1f18] text-allow' : 'border-block/40 bg-[#24101a] text-block')}>
            {t.msg}
          </div>
        ) : null}
      </div>
    </ToastCtx.Provider>
  );
}
