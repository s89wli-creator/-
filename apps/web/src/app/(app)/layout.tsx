'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@rakan/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { LoadingState, Select, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n, useMe } from '@/lib/providers';
import type { Theme } from '@/lib/theme';

type NavItem = { href: string; label: MessageKey; permission?: Permission; icon: IconName };
const GROUPS: { label?: MessageKey; items: NavItem[] }[] = [
  {
    items: [
      { href: '/home', label: 'nav.home', icon: 'home' },
      { href: '/dashboard', label: 'nav.dashboard', permission: 'reports.read', icon: 'chart' },
    ],
  },
  {
    label: 'nav.group.sales',
    items: [
      { href: '/accounts', label: 'nav.accounts', permission: 'crm.account.read', icon: 'building' },
      { href: '/pipeline', label: 'nav.pipeline', permission: 'crm.opportunity.read', icon: 'kanban' },
      { href: '/visits', label: 'nav.visits', permission: 'crm.visit.read', icon: 'pin' },
      { href: '/tasks', label: 'nav.tasks', permission: 'crm.task.read', icon: 'checkSquare' },
    ],
  },
  {
    label: 'nav.group.team',
    items: [
      { href: '/team', label: 'nav.team', permission: 'team.member.read', icon: 'users' },
      { href: '/team/territories', label: 'nav.territories', permission: 'team.territory.read', icon: 'map' },
    ],
  },
  {
    label: 'nav.group.settings',
    items: [
      { href: '/settings/crm', label: 'nav.crmSettings', permission: 'crm.settings.manage', icon: 'sliders' },
      { href: '/settings/company', label: 'nav.company', permission: 'tenant.settings.read', icon: 'settings' },
      { href: '/settings/audit', label: 'nav.audit', permission: 'audit.read', icon: 'list' },
      { href: '/settings/security', label: 'nav.security', icon: 'lock' },
    ],
  },
];
/** Phone bottom bar: at most 4 destinations + "More" (≤ 5 per the guidelines). */
const BOTTOM: string[] = ['/home', '/visits', '/tasks', '/accounts'];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');
}

function ThemeSwitch() {
  const { t, theme, setTheme } = useI18n();
  const options: { id: Theme; icon: IconName; label: MessageKey }[] = [
    { id: 'light', icon: 'sun', label: 'theme.light' },
    { id: 'system', icon: 'monitor', label: 'theme.system' },
    { id: 'dark', icon: 'moon', label: 'theme.dark' },
  ];
  return (
    <div role="radiogroup" aria-label={t('theme.label')} className="grid grid-cols-3 gap-1 rounded-lg bg-subtle-strong p-1">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={theme === o.id}
          title={t(o.label)}
          onClick={() => setTheme(o.id)}
          className={cx(
            'flex min-h-9 items-center justify-center gap-1.5 rounded-md text-xs transition-[background-color,color,box-shadow] duration-150',
            theme === o.id ? 'bg-surface font-medium text-fg shadow-xs' : 'text-fg-muted hover:text-fg',
          )}
        >
          <Icon name={o.icon} size={16} />
          <span>{t(o.label)}</span>
        </button>
      ))}
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<'closed' | 'open' | 'closing'>('closed');

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/login');
  }, [me.error, router]);
  const closeDrawer = () => {
    if (drawer !== 'open') return;
    setDrawer('closing');
    window.setTimeout(() => setDrawer('closed'), 160);
  };
  useEffect(() => setDrawer('closed'), [pathname]);
  useEffect(() => {
    if (drawer !== 'open') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeDrawer();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  });

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

  if (!me.data) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <LoadingState card rows={5} />
      </div>
    );
  }
  const perms = me.data.activeTenant?.permissions ?? [];
  const allowed = (n: NavItem) => !n.permission || perms.includes(n.permission);
  const isActive = (href: string) => pathname === href || (href !== '/home' && href !== '/team' && pathname.startsWith(href + '/'));
  const flat = GROUPS.flatMap((g) => g.items).filter(allowed);
  const bottom = BOTTOM.map((h) => flat.find((n) => n.href === h)).filter(Boolean) as NavItem[];

  const NavLink = ({ n }: { n: NavItem }) => (
    <Link
      href={n.href}
      aria-current={isActive(n.href) ? 'page' : undefined}
      className={cx(
        'group relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-ui transition-colors duration-150',
        isActive(n.href) ? 'bg-brand-50 font-semibold text-brand-700' : 'text-fg-sub hover:bg-subtle-strong hover:text-fg',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'absolute inset-y-2 start-0 w-0.5 rounded-full bg-brand-600 transition-[transform,opacity] duration-200 ease-out',
          isActive(n.href) ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
        )}
      />
      <Icon name={n.icon} className={isActive(n.href) ? '' : 'text-fg-muted transition-colors group-hover:text-fg-sub'} />
      {t(n.label)}
    </Link>
  );

  const navContent = (
    <nav aria-label={t('nav.mainMenu')} className="space-y-5">
      {GROUPS.map((g, gi) => {
        const items = g.items.filter(allowed);
        if (!items.length) return null;
        return (
          <div key={gi}>
            {g.label && <p className="mb-1.5 px-3 text-xs font-medium text-fg-muted">{t(g.label)}</p>}
            <div className="space-y-0.5">{items.map((n) => <NavLink key={n.href} n={n} />)}</div>
          </div>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-3 px-1">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-600 text-lg font-bold text-on-brand shadow-xs" aria-hidden>ر</span>
      <div className="min-w-0">
        <p className="font-semibold leading-tight">{t('app.name')}</p>
        <p className="truncate text-xs text-fg-muted">{me.data.activeTenant?.name ?? '—'}</p>
      </div>
    </div>
  );

  const userPanel = (
    <div className="space-y-3 border-t border-line-soft pt-4">
      <div className="flex items-center gap-3 px-1">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-subtle-strong text-sm font-semibold text-fg-sub" aria-hidden>
          {initials(me.data.user.fullName)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{me.data.user.fullName}</p>
          <p className="truncate text-xs text-fg-muted"><bdi>{me.data.user.email}</bdi></p>
        </div>
      </div>
      <ThemeSwitch />
      <div className="grid grid-cols-2 gap-1">
        <button className="flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm text-fg-sub transition-colors hover:bg-subtle-strong" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
          <Icon name="globe" size={16} /> {t('common.language')}
        </button>
        <button className="flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm text-danger transition-colors hover:bg-danger-soft" onClick={() => logout.mutate()}>
          <Icon name="logout" size={16} /> {t('auth.logout')}
        </button>
      </div>
    </div>
  );

  const tenantSwitcher = me.data.memberships.length > 1 && (
    <div>
      <label htmlFor="tenant-switch" className="mb-1 block px-1 text-xs text-fg-muted">{t('nav.switchCompany')}</label>
      <Select id="tenant-switch" value={me.data.activeTenant?.id ?? ''} disabled={switchTenant.isPending} onChange={(e) => switchTenant.mutate(e.target.value)}>
        {me.data.memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.tenantName}</option>)}
      </Select>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      <a href="#main" className="fixed start-3 top-3 z-[60] -translate-y-20 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-on-brand transition-transform focus:translate-y-0">
        {t('common.skipToContent')}
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col gap-6 overflow-y-auto border-e border-line bg-surface p-4 lg:flex">
        {brand}
        {tenantSwitcher}
        {navContent}
        <div className="mt-auto">{userPanel}</div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-600 font-bold text-on-brand" aria-hidden>ر</span>
          <span className="truncate font-semibold">{me.data.activeTenant?.name ?? t('app.name')}</span>
        </div>
        <button
          className="grid size-11 place-items-center rounded-lg text-fg-sub transition-colors hover:bg-subtle-strong"
          aria-expanded={drawer === 'open'}
          aria-controls="mobile-drawer"
          aria-label={t('nav.mainMenu')}
          onClick={() => setDrawer('open')}
        >
          <Icon name="menu" />
        </button>
      </header>

      {/* Phone drawer (enters from the inline-start edge) */}
      {drawer !== 'closed' && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('nav.mainMenu')} id="mobile-drawer">
          <div className={cx('absolute inset-0 bg-scrim', drawer === 'closing' ? 'animate-fade-out' : 'animate-fade-in')} onClick={closeDrawer} />
          <div
            className={cx(
              'absolute inset-y-0 start-0 flex w-[min(20rem,86vw)] flex-col gap-6 overflow-y-auto bg-surface p-4 shadow-xl',
              drawer === 'closing' ? 'animate-fade-out' : 'animate-drawer-in',
            )}
          >
            <div className="flex items-center justify-between">
              {brand}
              <button className="grid size-11 place-items-center rounded-lg text-fg-sub hover:bg-subtle-strong" aria-label={t('common.close')} onClick={closeDrawer}>
                <Icon name="close" />
              </button>
            </div>
            {tenantSwitcher}
            {navContent}
            <div className="mt-auto">{userPanel}</div>
          </div>
        </div>
      )}

      <main id="main" className="min-w-0 flex-1 px-4 pb-28 pt-6 sm:px-8 lg:pb-12 lg:pt-10">
        <div key={pathname} className="mx-auto max-w-[70rem] animate-page-in">
          {!me.data.user.emailVerified && pathname !== '/settings/security' && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-fg">
              <span className="flex items-center gap-2"><Icon name="info" size={20} className="shrink-0 text-warn" />{t('security.email.banner')}</span>
              <Link href="/settings/security" className="font-medium text-brand-700 hover:underline">{t('security.email.resend')}</Link>
            </div>
          )}
          {children}
        </div>
      </main>

      {/* Phone bottom navigation */}
      {bottom.length > 0 && (
        <nav
          aria-label={t('nav.mainMenu')}
          className="fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
          style={{ gridTemplateColumns: `repeat(${bottom.length + 1}, minmax(0, 1fr))` }}
        >
          {bottom.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? 'page' : undefined}
              className={cx(
                'flex min-h-16 flex-col items-center justify-center gap-1 text-xs transition-colors duration-150',
                isActive(n.href) ? 'font-semibold text-brand-700' : 'text-fg-muted',
              )}
            >
              <span className={cx('grid h-8 w-14 place-items-center rounded-full transition-colors duration-200', isActive(n.href) && 'bg-brand-50')}>
                <Icon name={n.icon} />
              </span>
              {t(n.label)}
            </Link>
          ))}
          <button className="flex min-h-16 flex-col items-center justify-center gap-1 text-xs text-fg-muted" onClick={() => setDrawer('open')} aria-label={t('nav.more')}>
            <span className="grid h-8 w-14 place-items-center rounded-full"><Icon name="more" /></span>
            {t('nav.more')}
          </button>
        </nav>
      )}
    </div>
  );
}
