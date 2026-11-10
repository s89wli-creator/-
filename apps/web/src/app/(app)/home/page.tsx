'use client';

import { useQuery } from '@tanstack/react-query';
import type { Permission, TaskDto, VisitDto } from '@rakan/shared';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { Alert, Badge, Card, EmptyState, PageHeader, SectionTitle, formatTime } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useMe } from '@/lib/providers';

const SECTIONS: { href: string; label: MessageKey; permission: Permission; icon: IconName }[] = [
  { href: '/dashboard', label: 'nav.dashboard', permission: 'reports.read', icon: 'chart' },
  { href: '/accounts', label: 'nav.accounts', permission: 'crm.account.read', icon: 'building' },
  { href: '/pipeline', label: 'nav.pipeline', permission: 'crm.opportunity.read', icon: 'kanban' },
  { href: '/visits', label: 'nav.visits', permission: 'crm.visit.read', icon: 'pin' },
  { href: '/tasks', label: 'nav.tasks', permission: 'crm.task.read', icon: 'checkSquare' },
  { href: '/team', label: 'nav.team', permission: 'team.member.read', icon: 'users' },
  { href: '/settings/crm', label: 'nav.crmSettings', permission: 'crm.settings.manage', icon: 'sliders' },
  { href: '/settings/company', label: 'nav.company', permission: 'tenant.settings.read', icon: 'settings' },
];

function dayRange() {
  const offset = 3 * 3600_000;
  const local = new Date(Date.now() + offset);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86400_000).toISOString() };
}

export default function HomePage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const { data: me } = useMe();
  const { from, to } = dayRange();
  const membershipId = me?.activeTenant?.membershipId;
  const visits = useQuery({
    queryKey: ['visits', 'today', membershipId],
    queryFn: () => api<VisitDto[]>(`/crm/visits?from=${from}&to=${to}&repMembershipId=${membershipId}`),
    enabled: can('crm.visit.read') && !!membershipId,
  });
  const tasks = useQuery({ queryKey: ['tasks', 'home'], queryFn: () => api<TaskDto[]>('/crm/tasks?view=mine&limit=5'), enabled: can('crm.task.read') });
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
          {can('crm.visit.read') && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <SectionTitle>{t('home.todayVisits')}</SectionTitle>
                {visits.data?.length ? (
                  <ul className="stagger divide-y divide-line-soft">
                    {visits.data.map((v) => (
                      <li key={v.id}>
                        <Link href={`/visits/${v.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors duration-150 hover:bg-subtle">
                          <span className="w-14 text-sm font-semibold tabular-nums">{formatTime(v.scheduledStart, locale)}</span>
                          <span className="min-w-0 flex-1 truncate">{v.accountName}</span>
                          <Badge tone={v.status === 'completed' ? 'brand' : 'neutral'}>{t(`visits.status.${v.status}` as MessageKey)}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState icon="calendar">{t('home.noVisitsToday')}</EmptyState>
                )}
              </Card>
              <Card>
                <SectionTitle>{t('home.myTasks')}</SectionTitle>
                {tasks.data?.length ? (
                  <ul className="stagger divide-y divide-line-soft">
                    {tasks.data.map((x) => (
                      <li key={x.id} className="flex items-center gap-3 px-5 py-3">
                        <span className="min-w-0 flex-1 truncate">{x.title}</span>
                        {x.dueAt && new Date(x.dueAt) < new Date() && <Badge tone="warn">{t('tasks.overdue')}</Badge>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState icon="checkSquare">{t('tasks.empty')}</EmptyState>
                )}
                <div className="border-t border-line-soft px-5 py-1 text-sm"><Link href="/tasks" className="inline-flex min-h-11 items-center gap-1 text-brand-700 hover:underline">{t('nav.tasks')} <Icon name="chevronEnd" size={16} /></Link></div>
              </Card>
            </div>
          )}
          <div>
            <h2 className="mb-3 text-sm font-medium text-fg-muted">{t('home.sections')}</h2>
            <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {SECTIONS.filter((s) => can(s.permission)).map((s) => (
                <Link key={s.href} href={s.href}>
                  <Card interactive className="flex items-center gap-3 p-4">
                    <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-700"><Icon name={s.icon} /></span>
                    <p className="font-medium">{t(s.label)}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
