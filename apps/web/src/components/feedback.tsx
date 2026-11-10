'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Button, Modal, cx } from '@/components/ui';
import { useI18n } from '@/lib/providers';

// ---------------------------------------------------------------- toasts
// Transient confirmations for non-critical feedback: slide in from the top, auto-dismiss after 4s,
// announced via aria-live (MASTER.md §5–6; ux-guidelines #82–83).

type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: string; leaving?: boolean };
const ToastCtx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t: tr } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 160);
  }, []);
  const push = useCallback(
    (message: string, tone: Toast['tone'] = 'success') => {
      const id = ++seq.current;
      setToasts((all) => [...all.slice(-2), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:end-4 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-xl',
              t.leaving ? 'animate-fade-out' : 'animate-toast-in',
              t.tone === 'error' ? 'border-danger-line' : 'border-line',
            )}
          >
            <span
              className={cx(
                'grid size-7 shrink-0 place-items-center rounded-full',
                t.tone === 'success' ? 'bg-success-soft text-success' : t.tone === 'error' ? 'bg-danger-soft text-danger' : 'bg-brand-50 text-brand-700',
              )}
            >
              {t.tone === 'success' ? (
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" className="check-draw" aria-hidden>
                  <path d="M5 12.5 10 17.5 19 7" />
                </svg>
              ) : (
                <Icon name={t.tone === 'error' ? 'alert' : 'info'} size={16} />
              )}
            </span>
            <span className="flex-1 font-medium text-fg">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-subtle-strong" aria-label={tr('common.close')}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- confirm dialog
// Replaces window.confirm: styled, translated, RTL, and focus starts on "Cancel" for destructive actions.

type ConfirmOptions = { title: string; body?: string; confirmLabel?: string; tone?: 'danger' | 'default' };
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const resolver = useRef<(v: boolean) => void>(undefined);
  const confirm = useCallback((o: ConfirmOptions) => {
    setState({ ...o, open: true });
    return new Promise<boolean>((resolve) => (resolver.current = resolve));
  }, []);
  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setState((s) => (s ? { ...s, open: false } : s));
  };
  const danger = state?.tone !== 'default';
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!state?.open} onClose={() => close(false)} title={state?.body ? state.title : t('confirm.title')}>
        <div className="flex items-start gap-4">
          {danger && <span className="grid size-10 shrink-0 place-items-center rounded-full bg-danger-soft text-danger"><Icon name="alert" /></span>}
          <p className="pt-2 text-ui text-fg-sub">{state?.body ?? state?.title}</p>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" autoFocus onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel ?? t('common.confirm')}</Button>
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
