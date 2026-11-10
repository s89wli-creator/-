'use client';

import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/lib/providers';

const POINTS: { icon: 'pin' | 'checkSquare' | 'chart'; key: MessageKey }[] = [
  { icon: 'pin', key: 'auth.panel.point1' },
  { icon: 'checkSquare', key: 'auth.panel.point2' },
  { icon: 'chart', key: 'auth.panel.point3' },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Brand panel (desktop) */}
      <aside className="relative hidden overflow-hidden bg-brand-700 p-12 text-on-brand lg:flex lg:flex-col">
        <div aria-hidden className="pointer-events-none absolute -end-24 -top-24 size-96 rounded-full bg-on-brand/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -start-16 size-[28rem] rounded-full bg-on-brand/5" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-on-brand/15 text-xl font-bold" aria-hidden>ر</span>
          <div>
            <p className="text-lg font-semibold leading-tight">{t('app.name')}</p>
            <p className="text-sm opacity-80">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="relative my-auto max-w-md">
          <h2 className="animate-fade-up text-3xl font-semibold leading-snug [text-wrap:balance]">{t('auth.panel.title')}</h2>
          <ul className="stagger mt-8 space-y-4">
            {POINTS.map((p) => (
              <li key={p.key} className="flex items-center gap-3 text-base">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-on-brand/15"><Icon name={p.icon} /></span>
                {t(p.key)}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative flex items-center gap-2 text-sm opacity-80">
          <Icon name="lock" size={16} /> {t('auth.panel.foot')}
        </p>
      </aside>

      {/* Form column */}
      <div className="flex min-h-dvh flex-col">
        <header className="flex items-center justify-between px-4 py-4 sm:px-8">
          <div className="flex items-center gap-2 lg:invisible">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-lg font-bold text-on-brand" aria-hidden>ر</span>
            <div>
              <p className="font-semibold leading-tight">{t('app.name')}</p>
              <p className="text-xs text-fg-muted">{t('app.tagline')}</p>
            </div>
          </div>
          <button
            className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-fg-sub transition-colors hover:bg-subtle-strong"
            onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
          >
            <Icon name="globe" size={16} /> {t('common.language')}
          </button>
        </header>
        <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:items-center sm:pt-0">
          <div className="w-full max-w-[26rem] animate-scale-in rounded-2xl border border-line bg-surface p-6 shadow-md sm:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
