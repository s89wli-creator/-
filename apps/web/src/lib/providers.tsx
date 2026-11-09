'use client';

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, Permission } from '@rakan/shared';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { LOCALE_COOKIE, errorMessage, translate, type Locale, type MessageKey } from './i18n';

interface I18nValue {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  err: (e: unknown) => string;
  setLocale: (l: Locale) => void;
}
const I18nContext = createContext<I18nValue | null>(null);

export function Providers({ locale: initial, children }: { locale: Locale; children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
          },
        },
      }),
  );
  const [locale, setLocaleState] = useState<Locale>(initial);
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    setLocaleState(l);
  }, []);
  const value: I18nValue = {
    locale,
    setLocale,
    t: (key, vars) => translate(locale, key, vars),
    err: (e) => errorMessage(locale, e instanceof ApiError ? e.code : 'UNKNOWN'),
  };
  return (
    <I18nContext.Provider value={value}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside Providers');
  return v;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/auth/me'),
    retry: false,
  });
}

export function useCan(): (p: Permission) => boolean {
  const { data } = useMe();
  return (p) => !!data?.activeTenant?.permissions.includes(p);
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (key: string) => qc.invalidateQueries({ queryKey: [key] });
}
