import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n';
import { ConfirmProvider, ToastProvider } from '@/components/feedback';
import { Providers } from '@/lib/providers';
import { THEME_COOKIE, type Theme } from '@/lib/theme';
import './globals.css';

const plex = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'راكان — Rakan', template: '%s · راكان' },
  description: 'موظف المبيعات الذكي للشركات',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  applicationName: 'راكان',
  appleWebApp: { capable: true, title: 'راكان', statusBarStyle: 'default' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#111312' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const locale: Locale = jar.get(LOCALE_COOKIE)?.value === 'en' ? 'en' : 'ar';
  const stored = jar.get(THEME_COOKIE)?.value;
  const theme: Theme = stored === 'light' || stored === 'dark' ? stored : 'system';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className={plex.variable} data-theme={theme === 'system' ? undefined : theme}>
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
