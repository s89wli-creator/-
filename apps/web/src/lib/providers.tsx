'use client';

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, Permission } from '@rakan/shared';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { setOfflineUser } from './offline';
import { LOCALE_COOKIE, errorMessage, translate, type Locale, type MessageKey } from './i18n';
import { THEME_COOKIE, type Theme } from './theme';

interface I18nValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  err: (e: unknown) => string;
  setLocale: (l: Locale) => void;
}
const I18nContext = createContext<I18nValue | null>(null);

export function Providers({ locale: initial, theme: initialTheme, children }: { locale: Locale; theme: Theme; children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Run queries even when the browser reports offline: the API client then serves the device copy.
            networkMode: 'always',
            retry: (count, e) => !(e instanceof ApiError && ((e.status >= 400 && e.status < 500) || e.code === 'NETWORK')) && count < 2,
          },
          mutations: { networkMode: 'always' },
        },
      }),
  );
  const [locale, setLocaleState] = useState<Locale>(initial);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const setTheme = useCallback((th: Theme) => {
    document.cookie = `${THEME_COOKIE}=${th}; path=/; max-age=31536000; samesite=lax`;
    if (th === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = th;
    setThemeState(th);
  }, []);
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    setLocaleState(l);
  }, []);
  const value: I18nValue = {
    theme,
    setTheme,
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
    queryFn: async () => {
      const me = await api<MeResponse>('/auth/me');
      setOfflineUser(me.user.id);
      return me;
    },
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
