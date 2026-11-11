'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Logo } from '@/components/brand/Logo';
import { Icon, type IconName } from '@/components/icons';
import { Alert, ButtonLink, Card, LoadingState, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n, useMe } from '@/lib/providers';

const NAV: { href: string; label: MessageKey; icon: IconName }[] = [
  { href: '/platform', label: 'platform.nav.overview', icon: 'chart' },
  { href: '/platform/tenants', label: 'platform.nav.tenants', icon: 'building' },
  { href: '/platform/plans', label: 'platform.nav.plans', icon: 'sliders' },
  { href: '/platform/voice', label: 'platform.nav.voice', icon: 'speaker' },
  { href: '/platform/audit', label: 'platform.nav.audit', icon: 'list' },
];

/** Separate console for Rakan operators (not a company workspace). */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  const { t, err } = useI18n();
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  // Probe once so a missing second step is explained before any page loads.
  const probe = useQuery({ queryKey: ['platform-probe'], queryFn: () => api('/platform/overview'), enabled: !!me.data?.user.isPlatformAdmin, retry: false });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/login');
  }, [me.error, router]);

  if (!me.data) return <div className="mx-auto max-w-5xl px-4 py-10"><LoadingState card rows={5} /></div>;
  const active = (href: string) => (href === '/platform' ? pathname === href : pathname.startsWith(href));
  const blocked = !me.data.user.isPlatformAdmin
    ? 'forbidden'
    : probe.error instanceof ApiError && probe.error.code === 'PLATFORM_MFA_REQUIRED' ? 'mfa' : null;

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="on-petrol flex shrink-0 flex-col gap-6 p-4 lg:sticky lg:top-0 lg:h-dvh lg:w-64">
        <div className="space-y-1 px-1">
          <Logo height={28} tone="reverse" label={t('app.name')} />
          <p className="text-xs text-fg-muted">{t('platform.title')}</p>
        </div>
        {!blocked && (
          <nav aria-label={t('platform.title')} className="flex gap-1 overflow-x-auto lg:flex-col">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active(n.href) ? 'page' : undefined}
                className={cx(
                  'flex min-h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-ui transition-colors duration-150',
                  active(n.href) ? 'bg-petrol-deep font-semibold text-accent' : 'text-fg-sub hover:bg-subtle-strong hover:text-fg',
                )}
              >
                <Icon name={n.icon} />
                <span className="flex-1">{t(n.label)}</span>
                {active(n.href) && <span aria-hidden className="size-2 rounded-full bg-accent" />}
              </Link>
            ))}
          </nav>
        )}
        <div className="mt-auto hidden lg:block">
          <Link href="/home" className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-fg-sub hover:bg-subtle-strong hover:text-fg">
            <Icon name="chevronStart" size={16} /> {t('platform.back')}
          </Link>
        </div>
      </aside>
      <main id="main" className="min-w-0 flex-1 px-4 pb-16 pt-6 sm:px-8 lg:pt-10">
        <div key={pathname} className="mx-auto max-w-[72rem] animate-page-in">
          {blocked === 'forbidden' && (
            <Card className="p-6">
              <Alert tone="error">{t('platform.forbidden')}</Alert>
              <div className="mt-4"><ButtonLink href="/home">{t('platform.back')}</ButtonLink></div>
            </Card>
          )}
          {blocked === 'mfa' && (
            <Card className="space-y-4 p-6">
              <Alert tone="warn">{err(probe.error)}</Alert>
              <p className="text-fg-sub">{t('platform.mfaHint')}</p>
              <ButtonLink href="/settings/security" variant="primary" icon="lock">{t('security.mfa.start')}</ButtonLink>
            </Card>
          )}
          {!blocked && (probe.isLoading ? <LoadingState card rows={4} /> : children)}
        </div>
      </main>
    </div>
  );
}
