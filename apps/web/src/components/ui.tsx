'use client';

import type React from 'react';
import {
  forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { useI18n } from '@/lib/providers';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'danger-solid';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-on-brand shadow-xs hover:bg-brand-700 disabled:opacity-60',
  secondary: 'bg-surface text-fg border border-line shadow-xs hover:bg-subtle hover:border-line-strong disabled:opacity-60',
  danger: 'bg-surface text-danger border border-danger-line hover:bg-danger-soft disabled:opacity-60',
  'danger-solid': 'bg-danger text-surface shadow-xs hover:opacity-90 disabled:opacity-60',
  ghost: 'text-fg-sub hover:bg-subtle-strong hover:text-fg disabled:opacity-50',
};

/** 44px min target, colour transitions 150ms, press feedback scale .98 in 100ms (MASTER.md §5). */
export function Button({
  variant = 'primary', loading, className, children, disabled, icon, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; icon?: IconName }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'relative inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-lg px-4 text-ui font-medium',
        'transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out',
        'active:scale-[0.98] active:duration-100 disabled:cursor-not-allowed disabled:active:scale-100',
        variants[variant],
        className,
      )}
    >
      {loading ? <Spinner className="size-4" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={cx(
        'grid size-11 place-items-center rounded-lg text-fg-sub transition-[background-color,color,transform] duration-150',
        'hover:bg-subtle-strong hover:text-fg active:scale-95 disabled:opacity-40',
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-current border-e-transparent', className)} aria-hidden />;
}

/** Link styled as a button (navigation must stay a link for semantics and deep-linking). */
export function ButtonLink({ href, children, variant = 'secondary', icon, download, className }: { href: string; children: ReactNode; variant?: Variant; icon?: IconName; download?: boolean; className?: string }) {
  const cls = cx(
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-ui font-medium transition-[background-color,border-color,transform] duration-150 active:scale-[0.98]',
    variants[variant],
    className,
  );
  const inner = (
    <>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </>
  );
  return download ? <a href={href} download className={cls}>{inner}</a> : <Link href={href} className={cls}>{inner}</Link>;
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex min-h-9 items-center gap-1 text-sm text-brand-700 hover:underline">
      <Icon name="chevronStart" size={16} className="transition-transform duration-150 group-hover:-translate-x-0.5 rtl:group-hover:translate-x-0.5" />
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- forms

export function Field({
  label, hint, error, children, htmlFor, optional,
}: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor: string; optional?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg-sub">
        {label}
        {optional && <span className="ms-1 font-normal text-fg-muted">({t('common.optional')})</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && (
        <p className="flex animate-fade-in items-center gap-1 text-xs text-danger" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      )}
    </div>
  );
}

const control = cx(
  'block w-full min-h-11 rounded-lg border border-line-strong/70 bg-surface px-3 text-ui text-fg placeholder:text-fg-muted',
  'transition-[border-color,box-shadow] duration-150 hover:border-line-strong',
  'focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/15 focus-visible:outline-none',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/10 disabled:cursor-not-allowed disabled:bg-subtle disabled:text-fg-muted read-only:bg-subtle',
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} {...props} className={cx(control, className)} />;
});

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(control, 'cursor-pointer pe-8', className)} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(control, 'py-2.5 leading-relaxed', className)} />;
}

// ---------------------------------------------------------------- surfaces

export function Card({ children, className, interactive, as: As = 'section' }: { children: ReactNode; className?: string; interactive?: boolean; as?: 'section' | 'div' | 'article' }) {
  return (
    <As
      className={cx(
        'rounded-xl border border-line bg-surface shadow-xs',
        interactive && 'transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-brand-600/40 hover:shadow-md',
        className,
      )}
    >
      {children}
    </As>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
      <h2 className="text-base font-semibold">{children}</h2>
      {action}
    </div>
  );
}

type Tone = 'neutral' | 'brand' | 'warn' | 'muted' | 'success' | 'danger';
export function Badge({ children, tone = 'neutral', dot }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  const tones: Record<Tone, string> = {
    neutral: 'bg-subtle-strong text-fg-sub',
    brand: 'bg-brand-50 text-brand-700',
    warn: 'bg-warn-soft text-warn',
    muted: 'bg-subtle text-fg-muted',
    success: 'bg-success-soft text-success',
    danger: 'bg-danger-soft text-danger',
  };
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function Alert({ tone, children }: { tone: 'error' | 'success' | 'info' | 'warn'; children: ReactNode }) {
  const tones = {
    error: ['border-danger-line bg-danger-soft text-danger', 'alert'],
    success: ['border-success/20 bg-success-soft text-success', 'checkCircle'],
    info: ['border-line bg-subtle text-fg-sub', 'info'],
    warn: ['border-warn-line bg-warn-soft text-warn', 'alert'],
  } as const;
  const [cls, icon] = tones[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex animate-fade-in gap-3 rounded-lg border px-4 py-3 text-sm', cls)}>
      <Icon name={icon} className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-fg [text-wrap:balance]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ---------------------------------------------------------------- states

export function Skeleton({ className }: { className?: string }) {
  return <span className={cx('skeleton block', className)} aria-hidden />;
}

/** Skeleton shaped like a list of rows — reserves layout so content does not jump when it arrives. */
export function SkeletonList({ rows = 5, withAside = true }: { rows?: number; withAside?: boolean }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className="divide-y divide-line-soft">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          {withAside && <Skeleton className="h-6 w-16 rounded-full" />}
        </div>
      ))}
    </div>
  );
}

/** Inside a card: rows only. As a whole-page state (`card`): wrapped in its own card. */
export function LoadingState({ rows = 4, card }: { rows?: number; card?: boolean }) {
  return card ? (
    <Card className="animate-fade-in">
      <SkeletonList rows={rows} />
    </Card>
  ) : (
    <SkeletonList rows={rows} />
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, err } = useI18n();
  return (
    <Card className="flex animate-fade-up flex-col items-center px-6 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger"><Icon name="alert" /></span>
      <p className="mt-4 font-semibold">{t('common.errorTitle')}</p>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">{err(error)}</p>
      {onRetry && <Button variant="secondary" className="mt-5" onClick={onRetry}>{t('common.retry')}</Button>}
    </Card>
  );
}

/** Empty state: icon + message + optional action (never a blank area). */
export function EmptyState({ children, icon = 'inbox', action }: { children: ReactNode; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="flex animate-fade-in flex-col items-center px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-subtle-strong text-fg-muted"><Icon name={icon} /></span>
      <p className="mt-4 max-w-sm text-sm text-fg-muted">{children}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function NoPermission() {
  const { t } = useI18n();
  return (
    <Card>
      <EmptyState icon="lock">{t('common.noPermission')}</EmptyState>
    </Card>
  );
}

// ---------------------------------------------------------------- modal

/**
 * Accessible modal on the native <dialog> (focus trap + Esc from the browser).
 * Enter: backdrop fade + scale-in 220ms. Exit: data-closing plays a 160ms exit before the dialog closes.
 */
export function Modal({ open, onClose, title, children, size = 'md' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; size?: 'md' | 'lg' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(open);
  const { t } = useI18n();
  const titleId = useId(); // unique per dialog: several modals can coexist in the DOM

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      setMounted(true);
      d.removeAttribute('data-closing');
      if (!d.open) d.showModal();
      return;
    }
    if (!d.open) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      d.close();
      setMounted(false);
      return;
    }
    d.setAttribute('data-closing', '');
    const id = window.setTimeout(() => {
      d.close();
      d.removeAttribute('data-closing');
      setMounted(false);
    }, 160);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault(); // let the exit animation run
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on backdrop
      }}
      aria-labelledby={titleId}
      className={cx(
        'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-xl',
        size === 'lg' ? 'max-w-2xl' : 'max-w-lg',
      )}
    >
      <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
        <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
        <IconButton icon="close" label={t('common.close')} className="-me-2 -mt-1.5" onClick={onClose} />
      </div>
      <div className="px-6 pb-6 pt-2">{mounted && children}</div>
    </dialog>
  );
}

// ---------------------------------------------------------------- navigation

/** Tabs with a sliding indicator (transform only). Arrow keys move focus (RTL-aware). */
export function Tabs<T extends string>({
  tabs, value, onChange, label,
}: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLButtonElement>(`[data-tab="${value}"]`);
    if (!list || !el) return;
    setIndicator({ x: el.offsetLeft, w: el.offsetWidth });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value, tabs.length]);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className="relative -mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:none]"
      onKeyDown={(e) => {
        const i = tabs.findIndex((x) => x.id === value);
        const rtl = document.documentElement.dir === 'rtl';
        const next = e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') ? 1 : e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? -1 : 0;
        if (!next) return;
        const target = tabs[(i + next + tabs.length) % tabs.length]!;
        onChange(target.id);
        listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"]`)?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          data-tab={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          className={cx(
            'min-h-11 shrink-0 whitespace-nowrap rounded-t-md px-3 text-ui transition-colors duration-150',
            value === tab.id ? 'font-semibold text-brand-700' : 'text-fg-muted hover:text-fg',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={cx('ms-1.5 rounded-full px-1.5 text-xs tabular-nums', value === tab.id ? 'bg-brand-50' : 'bg-subtle-strong')}>{tab.count}</span>
          )}
        </button>
      ))}
      {indicator && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-brand-600 transition-[transform,width] duration-200 ease-out"
          style={{ width: indicator.w, transform: `translateX(${indicator.x}px)`, left: 0 }}
        />
      )}
    </div>
  );
}

export function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-2 border-t border-line-soft px-4 py-3 text-sm" aria-label="pagination">
      <Button variant="secondary" icon="chevronStart" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t('common.previous')}</Button>
      <span className="text-fg-muted tabular-nums">{t('common.pageOf', { page, pages })}</span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('common.next')} <Icon name="chevronEnd" size={16} />
      </Button>
    </nav>
  );
}

// ---------------------------------------------------------------- data display

/** Counts up to the value once (700ms, ease-out). Reduced motion: shows the final value immediately. */
export function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 700);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(a + (value - a) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tabular-nums">{format(Math.round(shown))}</span>;
}

export function formatDate(iso: string, locale: 'ar' | 'en', withTime = false): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
    timeZone: 'Asia/Riyadh',
  }).format(new Date(iso));
}

export function formatMoney(value: number | null | undefined, locale: 'ar' | 'en'): string {
  if (value === null || value === undefined) return '—';
  const n = new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { maximumFractionDigits: 0 }).format(value);
  return locale === 'ar' ? `${n} ر.س` : `SAR ${n}`;
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

/** <input type="datetime-local"> value in Riyadh time (UTC+3) <-> ISO. */
export function toLocalInput(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 3 * 3600_000);
  return d.toISOString().slice(0, 16);
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  return new Date(`${v}:00+03:00`).toISOString();
}

export function formatTime(iso: string, locale: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { timeStyle: 'short', timeZone: 'Asia/Riyadh' }).format(new Date(iso));
}

export function formatDay(iso: string, locale: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Riyadh',
  }).format(new Date(iso));
}
