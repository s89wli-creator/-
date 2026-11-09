'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@rakan/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LoadingState, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n, useMe } from '@/lib/providers';

const NAV: { href: string; label: MessageKey; permission?: Permission; icon: string }[] = [
  { href: '/home', label: 'nav.home', icon: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z' },
  { href: '/dashboard', label: 'nav.dashboard', permission: 'reports.read', icon: 'M4 20V10m6 10V4m6 16v-7m4 7H2' },
  { href: '/accounts', label: 'nav.accounts', permission: 'crm.account.read', icon: 'M3 21V7l9-4 9 4v14M8 21v-6h8v6M8 10h.01M12 10h.01M16 10h.01' },
  { href: '/pipeline', label: 'nav.pipeline', permission: 'crm.opportunity.read', icon: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z' },
  { href: '/visits', label: 'nav.visits', permission: 'crm.visit.read', icon: 'M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' },
  { href: '/tasks', label: 'nav.tasks', permission: 'crm.task.read', icon: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9' },
  { href: '/team', label: 'nav.team', permission: 'team.member.read', icon: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-12 10a8 8 0 0 1 16 0' },
  { href: '/team/territories', label: 'nav.territories', permission: 'team.territory.read', icon: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14' },
  { href: '/settings/crm', label: 'nav.crmSettings', permission: 'crm.settings.manage', icon: 'M4 6h16M4 12h10M4 18h6m8-3 3 3-3 3' },
  { href: '/settings/company', label: 'nav.company', permission: 'tenant.settings.read', icon: 'M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 9h.01M12 9h.01M16 9h.01' },
  { href: '/settings/audit', label: 'nav.audit', permission: 'audit.read', icon: 'M9 5h10M9 12h10M9 19h10M5 5h.01M5 12h.01M5 19h.01' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/login');
  }, [me.error, router]);
  useEffect(() => setMenuOpen(false), [pathname]);

  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      router.replace('/login');
    },
  });
  const switchTenant = useMutation({
    mutationFn: (tenantId: string) => api('/auth/switch-tenant', { method: 'POST', body: { tenantId } }),
    onSuccess: () => {
      qc.clear();
      router.replace('/home');
    },
  });

  if (!me.data) return <LoadingState />;
  const perms = me.data.activeTenant?.permissions ?? [];
  const items = NAV.filter((n) => !n.permission || perms.includes(n.permission));
  const isActive = (href: string) =>
    pathname === href || (href !== '/home' && href !== '/team' && pathname.startsWith(href + '/'));

  const nav = (
    <nav className="space-y-1" aria-label="main">
      {items.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={isActive(n.href) ? 'page' : undefined}
          className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm ${
            isActive(n.href) ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-100'
          }`}
        >
          <Icon d={n.icon} />
          {t(n.label)}
        </Link>
      ))}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-2 px-1">
        <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-lg font-bold text-white" aria-hidden>ر</span>
        <div className="min-w-0">
          <p className="font-semibold leading-tight">{t('app.name')}</p>
          <p className="truncate text-xs text-ink-500">{me.data.activeTenant?.name ?? '—'}</p>
        </div>
      </div>
      {me.data.memberships.length > 1 && (
        <div>
          <label htmlFor="tenant-switch" className="mb-1 block px-1 text-xs text-ink-500">{t('nav.switchCompany')}</label>
          <Select
            id="tenant-switch"
            value={me.data.activeTenant?.id ?? ''}
            disabled={switchTenant.isPending}
            onChange={(e) => switchTenant.mutate(e.target.value)}
          >
            {me.data.memberships.map((m) => (
              <option key={m.tenantId} value={m.tenantId}>{m.tenantName}</option>
            ))}
          </Select>
        </div>
      )}
      {nav}
      <div className="mt-auto space-y-1 border-t border-ink-100 pt-4">
        <p className="truncate px-3 text-sm font-medium">{me.data.user.fullName}</p>
        <p className="truncate px-3 text-xs text-ink-500"><bdi>{me.data.user.email}</bdi></p>
        <button className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm text-ink-700 hover:bg-ink-100" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
          {t('common.language')}
        </button>
        <button className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm text-red-700 hover:bg-red-50" onClick={() => logout.mutate()}>
          {t('auth.logout')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="hidden w-64 shrink-0 border-e border-ink-200 bg-white lg:block lg:min-h-dvh">{sidebar}</aside>
      <div className="flex items-center justify-between border-b border-ink-200 bg-white px-4 py-3 lg:hidden">
        <span className="font-semibold">{me.data.activeTenant?.name ?? t('app.name')}</span>
        <button
          className="grid size-11 place-items-center rounded-lg hover:bg-ink-100"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label="menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon d="M4 7h16M4 12h16M4 17h16" />
        </button>
      </div>
      {menuOpen && (
        <div id="mobile-nav" className="border-b border-ink-200 bg-white lg:hidden">{sidebar}</div>
      )}
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
