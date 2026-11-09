'use client';

import Link from 'next/link';
import { Alert, Card, PageHeader } from '@/components/ui';
import type { MessageKey } from '@/lib/i18n';
import { useI18n, useMe } from '@/lib/providers';

const SECTIONS: { href: string; label: MessageKey; permission: string }[] = [
  { href: '/team', label: 'nav.team', permission: 'team.member.read' },
  { href: '/team/territories', label: 'nav.territories', permission: 'team.territory.read' },
  { href: '/settings/company', label: 'nav.company', permission: 'tenant.settings.read' },
  { href: '/settings/audit', label: 'nav.audit', permission: 'audit.read' },
];

export default function HomePage() {
  const { t } = useI18n();
  const { data: me } = useMe();
  if (!me) return null;
  const tenant = me.activeTenant;
  return (
    <>
      <PageHeader
        title={t('home.welcome', { name: me.user.fullName })}
        subtitle={tenant ? t('home.roleIn', { company: tenant.name, role: t(`role.${tenant.role}` as MessageKey) }) : undefined}
      />
      {!tenant ? (
        <Alert tone="info">{t('home.noTenant')}</Alert>
      ) : (
        <div className="space-y-6">
          <div>
            <h2 className="mb-3 text-sm font-medium text-ink-500">{t('home.sections')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {SECTIONS.filter((s) => tenant.permissions.includes(s.permission as never)).map((s) => (
                <Link key={s.href} href={s.href}>
                  <Card className="p-5 transition-colors hover:border-brand-500">
                    <p className="font-medium">{t(s.label)}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
          <Alert tone="info">{t('home.phaseNote')}</Alert>
        </div>
      )}
    </>
  );
}
