import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n';
import { Providers } from '@/lib/providers';
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
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0d8571' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale: Locale = (await cookies()).get(LOCALE_COOKIE)?.value === 'en' ? 'en' : 'ar';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className={plex.variable}>
      <body className="min-h-dvh font-sans">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
