'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardDto } from '@rakan/shared';
import { useState } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { AnimatedNumber, Card, EmptyState, ErrorState, NoPermission, PageHeader, SectionTitle, Select, Skeleton, formatMoney } from '@/components/ui';
import { api } from '@/lib/api';
import { useCrmSettings } from '@/lib/crm';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

type Period = 'month' | '30' | 'quarter';

function range(p: Period): { from: string; to: string } {
  const now = new Date();
  if (p === 'month') {
    const riyadh = new Date(now.getTime() + 3 * 3600_000);
    const from = new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), 1) - 3 * 3600_000);
    const to = new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth() + 1, 1) - 3 * 3600_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const days = p === '30' ? 30 : 90;
  return { from: new Date(now.getTime() - days * 86400_000).toISOString(), to: new Date(now.getTime() + 60_000).toISOString() };
}

function Stat({ label, value, format, hint, icon, emphasis }: { label: string; value: number | null; format: (n: number) => string; hint?: string; icon: IconName; emphasis?: boolean }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{label}</p>
        <span className={`grid size-8 place-items-center rounded-lg ${emphasis ? 'bg-brand-50 text-brand-700' : 'bg-subtle-strong text-fg-muted'}`}>
          <Icon name={icon} size={16} />
        </span>
      </div>
      <p className="mt-2 font-display text-3xl font-semibold text-heading">{value === null ? '—' : <AnimatedNumber value={value} format={format} />}</p>
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-4 p-5">
            <Skeleton className="h-4 w-1/3" />
            {Array.from({ length: 5 }, (_, j) => <Skeleton key={j} className="h-2 w-full" />)}
          </Card>
        ))}
      </div>
    </div>
  );
}

function Bar({ label, value, max, detail }: { label: string; value: number; max: number; detail: string }) {
  return (
    <li className="space-y-1">
      <div className="flex justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="text-fg-muted tabular-nums">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-subtle-strong" aria-hidden>
        <div className="bar-grow h-full rounded-full bg-brand-600" style={{ width: `${max && value ? Math.max(2, (value / max) * 100) : 0}%` }} />
      </div>
    </li>
  );
}

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const settings = useCrmSettings();
  const [period, setPeriod] = useState<Period>('month');
  const [trackId, setTrackId] = useState('');
  const r = range(period);
  const q = useQuery({
    queryKey: ['dashboard', period, trackId],
    queryFn: () => api<DashboardDto>(`/reports/dashboard?from=${r.from}&to=${r.to}${trackId ? `&trackId=${trackId}` : ''}`),
    enabled: can('reports.read'),
  });
  if (!can('reports.read')) return <NoPermission />;
  const d = q.data;
  const n = (v: number) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US').format(v);

  return (
    <>
      <PageHeader
        title={t('dash.title')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Select aria-label={t('dash.period')} value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="w-44">
              {(['month', '30', 'quarter'] as const).map((p) => <option key={p} value={p}>{t(`dash.period.${p}` as MessageKey)}</option>)}
            </Select>
            {!!settings.data?.tracks.length && (
              <Select aria-label={t('accounts.track')} value={trackId} onChange={(e) => setTrackId(e.target.value)} className="w-44">
                <option value="">{t('crmSettings.allTracks')}</option>
                {settings.data.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
              </Select>
            )}
          </div>
        }
      />
      {q.isLoading ? <DashboardSkeleton /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : d && (
        <div className="space-y-6">
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon="chart" emphasis label={t('dash.pipelineValue')} value={d.totals.pipelineValue} format={(v) => formatMoney(v, locale)} hint={`${t('dash.open')}: ${n(d.totals.openOpportunities)}`} />
            <Stat icon="checkCircle" emphasis label={t('dash.won')} value={d.totals.won} format={n} hint={formatMoney(d.totals.wonValue, locale)} />
            <Stat icon="sparkle" label={t('dash.winRate')} value={d.totals.winRate === null ? null : Math.round(d.totals.winRate * 100)} format={(v) => `${v}%`} hint={`${t('dash.lost')}: ${n(d.totals.lost)}`} />
            <Stat icon="upload" label={t('dash.proposals')} value={d.totals.proposalsSent} format={n} />
            <Stat icon="pin" label={t('dash.visitsCompleted')} value={d.totals.visitsCompleted} format={n} hint={`${t('dash.visitsScheduled')}: ${n(d.totals.visitsScheduled)}`} />
            <Stat icon="calendar" label={t('dash.visitRate')} value={d.totals.visitCompletionRate === null ? null : Math.round(d.totals.visitCompletionRate * 100)} format={(v) => `${v}%`} />
            <Stat icon="checkSquare" label={t('dash.followRate')} value={d.totals.followUpCompletionRate === null ? null : Math.round(d.totals.followUpCompletionRate * 100)} format={(v) => `${v}%`} hint={`${t('dash.overdue')}: ${n(d.totals.overdueTasks)}`} />
            <Stat icon="building" label={t('dash.accounts')} value={d.totals.accounts} format={n} hint={`${t('dash.newAccounts')}: ${n(d.totals.newAccounts)} · ${t('dash.qualified')}: ${n(d.totals.qualified)}`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle>{t('dash.funnel')}</SectionTitle>
              <ul className="space-y-3 p-5">
                {d.stageFunnel.map((s) => (
                  <Bar key={s.stageId} label={s.name} value={s.count} max={Math.max(...d.stageFunnel.map((x) => x.count))} detail={`${n(s.count)} · ${formatMoney(s.value, locale)}`} />
                ))}
              </ul>
            </Card>
            <Card>
              <SectionTitle>{t('dash.lossReasons')}</SectionTitle>
              {d.lossReasons.length ? (
                <ul className="space-y-3 p-5">
                  {d.lossReasons.map((l) => <Bar key={l.label} label={l.label} value={l.count} max={d.lossReasons[0]!.count} detail={n(l.count)} />)}
                </ul>
              ) : (
                <EmptyState icon="checkCircle">{t('dash.noLosses')}</EmptyState>
              )}
            </Card>
          </div>
          <Card>
            <SectionTitle>{t('dash.byRep')}</SectionTitle>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="px-5 py-2 text-start font-medium">{t('dash.rep')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('dash.visitsCompleted')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('dash.tasksDone')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('dash.won')}</th>
                    <th scope="col" className="px-5 py-2 text-end font-medium">{t('dash.openValue')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {d.byRep.map((r) => (
                    <tr key={r.membershipId} className="transition-colors duration-150 hover:bg-subtle">
                      <td className="px-5 py-2.5 font-medium">{r.name}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums">{n(r.visitsCompleted)}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums">{n(r.tasksDone)}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums">{n(r.won)}</td>
                      <td className="px-5 py-2.5 text-end tabular-nums">{formatMoney(r.openValue, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
