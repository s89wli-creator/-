'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/providers';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <div className="flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-lg font-bold text-white" aria-hidden>ر</span>
          <div>
            <p className="font-semibold leading-tight">{t('app.name')}</p>
            <p className="text-xs text-ink-500">{t('app.tagline')}</p>
          </div>
        </div>
        <button className="text-sm text-ink-700 underline-offset-4 hover:underline" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
          {t('common.language')}
        </button>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-md rounded-2xl border border-ink-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
      </main>
    </div>
  );
}
