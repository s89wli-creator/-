'use client';

import { useQuery } from '@tanstack/react-query';
import type { VisitDto } from '@rakan/shared';
import Link from 'next/link';
import { useState } from 'react';
import { VisitForm } from '@/components/crm/forms';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, NoPermission, PageHeader, Select, formatDay, formatTime } from '@/components/ui';
import { api } from '@/lib/api';
import { Icon } from '@/components/icons';
import { useMembers, weekStart } from '@/lib/crm';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

export default function VisitsPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const members = useMembers();
  const invalidate = useInvalidate();
  const [offset, setOffset] = useState(0);
  const [rep, setRep] = useState('');
  const [creating, setCreating] = useState(false);
  const from = new Date(weekStart().getTime() + offset * 7 * 86400_000);
  const to = new Date(from.getTime() + 7 * 86400_000);
  const visits = useQuery({
    queryKey: ['visits', 'week', from.toISOString(), rep],
    queryFn: () => api<VisitDto[]>(`/crm/visits?from=${from.toISOString()}&to=${to.toISOString()}${rep ? `&repMembershipId=${rep}` : ''}`),
    enabled: can('crm.visit.read'),
  });
  if (!can('crm.visit.read')) return <NoPermission />;

  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86400_000));
  const dayKey = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
  const todayKey = dayKey(new Date());

  return (
    <>
      <PageHeader
        title={t('visits.title')}
        subtitle={t('visits.subtitle')}
        actions={can('crm.visit.write') && <Button icon="plus" onClick={() => setCreating(true)}>{t('visits.new')}</Button>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setOffset((o) => o - 1)} aria-label={t('common.previous')}><Icon name="chevronStart" size={16} /></Button>
        <Button variant={offset === 0 ? 'primary' : 'secondary'} onClick={() => setOffset(0)}>{t('visits.thisWeek')}</Button>
        <Button variant="secondary" onClick={() => setOffset((o) => o + 1)} aria-label={t('common.next')}><Icon name="chevronEnd" size={16} /></Button>
        <span className="text-sm text-fg-muted">{formatDay(from.toISOString(), locale)} — {formatDay(new Date(to.getTime() - 1).toISOString(), locale)}</span>
        {can('team.member.read') && (
          <Select aria-label={t('visits.rep')} className="ms-auto w-52" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="">{t('visits.rep')}: {t('common.all')}</option>
            {members.data?.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
          </Select>
        )}
      </div>
      {visits.isLoading ? (
        <LoadingState card />
      ) : visits.error ? (
        <ErrorState error={visits.error} onRetry={() => visits.refetch()} />
      ) : !visits.data!.length ? (
        <Card><EmptyState icon="calendar" action={can('crm.visit.write') && <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>{t('visits.new')}</Button>}>{t('visits.empty')}</EmptyState></Card>
      ) : (
        <div className="space-y-4">
          {days.map((d) => {
            const items = visits.data!.filter((v) => dayKey(v.scheduledStart) === dayKey(d));
            if (!items.length) return null;
            return (
              <section key={d.toISOString()}>
                <h2 className={`mb-2 text-sm font-semibold ${dayKey(d) === todayKey ? 'text-brand-700' : 'text-fg-sub'}`}>{formatDay(d.toISOString(), locale)}</h2>
                <Card>
                  <ul className="stagger divide-y divide-line-soft">
                    {items.map((v) => (
                      <li key={v.id}>
                        <Link href={`/visits/${v.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-subtle">
                          <span className="w-14 shrink-0 text-sm font-semibold tabular-nums">{formatTime(v.scheduledStart, locale)}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{v.accountName}</p>
                            <p className="truncate text-sm text-fg-muted">{[v.accountCity, v.repName, v.purpose].filter(Boolean).join(' · ')}</p>
                          </div>
                          <Badge tone={v.status === 'completed' ? 'brand' : v.status === 'cancelled' ? 'muted' : v.status === 'in_progress' ? 'warn' : 'neutral'}>
                            {t(`visits.status.${v.status}` as MessageKey)}
                          </Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            );
          })}
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title={t('visits.new')} size="lg">
        <VisitForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); invalidate('visits'); }} />
      </Modal>
    </>
  );
}
