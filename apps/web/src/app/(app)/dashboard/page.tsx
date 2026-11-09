'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardDto } from '@rakan/shared';
import { useState } from 'react';
import { Card, EmptyState, ErrorState, LoadingState, NoPermission, PageHeader, Select, formatMoney, formatPercent } from '@/components/ui';
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
    </Card>
  );
}

function Bar({ label, value, max, detail }: { label: string; value: number; max: number; detail: string }) {
  return (
    <li className="space-y-1">
      <div className="flex justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="text-ink-500 tabular-nums">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden>
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${max && value ? Math.max(2, (value / max) * 100) : 0}%` }} />
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
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('dash.pipelineValue')} value={formatMoney(d.totals.pipelineValue, locale)} hint={`${t('dash.open')}: ${n(d.totals.openOpportunities)}`} />
            <Stat label={t('dash.won')} value={n(d.totals.won)} hint={formatMoney(d.totals.wonValue, locale)} />
            <Stat label={t('dash.winRate')} value={formatPercent(d.totals.winRate)} hint={`${t('dash.lost')}: ${n(d.totals.lost)}`} />
            <Stat label={t('dash.proposals')} value={n(d.totals.proposalsSent)} />
            <Stat label={t('dash.visitsCompleted')} value={n(d.totals.visitsCompleted)} hint={`${t('dash.visitsScheduled')}: ${n(d.totals.visitsScheduled)}`} />
            <Stat label={t('dash.visitRate')} value={formatPercent(d.totals.visitCompletionRate)} />
            <Stat label={t('dash.followRate')} value={formatPercent(d.totals.followUpCompletionRate)} hint={`${t('dash.overdue')}: ${n(d.totals.overdueTasks)}`} />
            <Stat label={t('dash.accounts')} value={n(d.totals.accounts)} hint={`${t('dash.newAccounts')}: ${n(d.totals.newAccounts)} · ${t('dash.qualified')}: ${n(d.totals.qualified)}`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="mb-4 font-semibold">{t('dash.funnel')}</h2>
              <ul className="space-y-3">
                {d.stageFunnel.map((s) => (
                  <Bar key={s.stageId} label={s.name} value={s.count} max={Math.max(...d.stageFunnel.map((x) => x.count))} detail={`${n(s.count)} · ${formatMoney(s.value, locale)}`} />
                ))}
              </ul>
            </Card>
            <Card className="p-5">
              <h2 className="mb-4 font-semibold">{t('dash.lossReasons')}</h2>
              {d.lossReasons.length ? (
                <ul className="space-y-3">
                  {d.lossReasons.map((l) => <Bar key={l.label} label={l.label} value={l.count} max={d.lossReasons[0]!.count} detail={n(l.count)} />)}
                </ul>
              ) : (
                <EmptyState>{t('dash.noLosses')}</EmptyState>
              )}
            </Card>
          </div>
          <Card>
            <h2 className="border-b border-ink-100 px-5 py-3 font-semibold">{t('dash.byRep')}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-ink-500">
                  <tr>
                    <th scope="col" className="px-5 py-2 text-start font-medium">{t('dash.rep')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('dash.visitsCompleted')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('dash.tasksDone')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('dash.won')}</th>
                    <th scope="col" className="px-5 py-2 text-end font-medium">{t('dash.openValue')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {d.byRep.map((r) => (
                    <tr key={r.membershipId}>
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
