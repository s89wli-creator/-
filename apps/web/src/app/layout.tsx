import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n';
import { ConfirmProvider, ToastProvider } from '@/components/feedback';
import { Providers } from '@/lib/providers';
import { THEME_COOKIE, type Theme } from '@/lib/theme';
// Fonts are bundled with the app (no request to Google at build or run time): Arabic + Latin subsets only.
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@fontsource/ibm-plex-sans-arabic/latin-400.css';
import '@fontsource/ibm-plex-sans-arabic/latin-500.css';
import '@fontsource/ibm-plex-sans-arabic/latin-600.css';
import '@fontsource/ibm-plex-sans-arabic/latin-700.css';
import '@fontsource/alexandria/arabic-400.css';
import '@fontsource/alexandria/arabic-600.css';
import '@fontsource/alexandria/arabic-700.css';
import '@fontsource/alexandria/arabic-800.css';
import '@fontsource/alexandria/latin-400.css';
import '@fontsource/alexandria/latin-600.css';
import '@fontsource/alexandria/latin-700.css';
import '@fontsource/alexandria/latin-800.css';
import './globals.css';


export const metadata: Metadata = {
  title: { default: 'راكان — Rakan', template: '%s · راكان' },
  description: 'موظف المبيعات الذكي للشركات',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  applicationName: 'راكان',
  appleWebApp: { capable: true, title: 'راكان', statusBarStyle: 'default' },
  icons: { icon: [{ url: '/brand/favicon.svg', type: 'image/svg+xml' }, { url: '/icons/favicon-32.png', sizes: '32x32' }], apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0e4a52' },
    { media: '(prefers-color-scheme: dark)', color: '#08292d' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const locale: Locale = jar.get(LOCALE_COOKIE)?.value === 'en' ? 'en' : 'ar';
  const stored = jar.get(THEME_COOKIE)?.value;
  const theme: Theme = stored === 'light' || stored === 'dark' ? stored : 'system';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} data-theme={theme === 'system' ? undefined : theme}>
      <body className="min-h-dvh bg-page font-sans text-base text-fg">
        <Providers locale={locale} theme={theme}>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
