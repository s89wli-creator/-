'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COACH_METRICS, type CoachMetric, type CoachReportDto, type CoachReportSummaryDto, type CoachTeamDto } from '@rakan/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AiNotice, useAiStatus } from '@/components/ai/panels';
import { Icon } from '@/components/icons';
import {
  Alert, Badge, Button, Card, CardHeading, EmptyState, ErrorState, LoadingState, NoPermission, PageHeader, Tabs, cx, formatDate, formatMoney,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useMe } from '@/lib/providers';

type View = 'mine' | 'team' | 'reports';
/** Higher is better, except for these. */
const LOWER_IS_BETTER: CoachMetric[] = ['tasks_overdue', 'deals_lost', 'hot_accounts_neglected'];
const KEY_METRICS: CoachMetric[] = ['visits_completed', 'visit_completion_pct', 'visits_interested', 'tasks_overdue', 'deals_won', 'won_amount', 'proposals_sent', 'hot_accounts_neglected'];

function useMetricFormat() {
  const { locale } = useI18n();
  return (k: CoachMetric, v: number) => (k === 'won_amount' ? formatMoney(v, locale) : k === 'visit_completion_pct' ? `${v}%` : String(v));
}

function MetricGrid({ metrics, median }: { metrics: CoachTeamDto['median']; median: CoachTeamDto['median'] }) {
  const { t } = useI18n();
  const fmt = useMetricFormat();
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {COACH_METRICS.map((k) => {
        const v = metrics[k];
        const m = median[k];
        const better = LOWER_IS_BETTER.includes(k) ? v < m : v > m;
        const worse = LOWER_IS_BETTER.includes(k) ? v > m : v < m;
        return (
          <li key={k} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-xs text-fg-muted">{t(`coach.metric.${k}` as MessageKey)}</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{fmt(k, v)}</p>
            <p className={cx('text-xs tabular-nums', better ? 'text-success' : worse ? 'text-warn' : 'text-fg-muted')}>
              {t('coach.median')}: {fmt(k, m)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function ReportView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ['coach-report', id], queryFn: () => api<CoachReportDto>(`/coach/reports/${id}`) });
  if (q.isLoading) return <LoadingState card />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"><Icon name="chevronStart" size={16} /> {t('coach.back')}</button>
      <Card className="space-y-2 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-xl font-semibold">{r.memberName}</h2>
          {r.trigger === 'schedule' && <Badge tone="accent">{t('coach.byScheduler')}</Badge>}
        </div>
        <p className="text-sm text-fg-muted">{t('coach.periodRange', { from: formatDate(`${r.from}T12:00:00Z`, locale), to: formatDate(`${r.to}T12:00:00Z`, locale) })}</p>
        {r.headline && <p className="text-lg leading-relaxed">{r.headline}</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <CardHeading>{t('coach.strengths')}</CardHeading>
          {r.strengths.length ? (
            <ul className="space-y-3">{r.strengths.map((s, i) => (
              <li key={i} className="flex gap-2"><Icon name="checkCircle" size={20} className="mt-0.5 shrink-0 text-success" /><span><span className="block">{s.text}</span><span className="text-xs text-fg-muted">{t(`coach.metric.${s.metric}` as MessageKey)}</span></span></li>
            ))}</ul>
          ) : <p className="text-sm text-fg-muted">—</p>}
        </Card>
        <Card className="p-5">
          <CardHeading>{t('coach.improvements')}</CardHeading>
          {r.improvements.length ? (
            <ul className="space-y-3">{r.improvements.map((s, i) => (
              <li key={i} className="space-y-1">
                <p>{s.text} <span className="text-xs text-fg-muted">· {t(`coach.metric.${s.metric}` as MessageKey)}</span></p>
                {s.action && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm"><span className="font-medium">{t('coach.action')}:</span> {s.action}</p>}
              </li>
            ))}</ul>
          ) : <p className="text-sm text-fg-muted">—</p>}
        </Card>
      </div>
      {r.objectionTips.length > 0 && (
        <Card className="p-5">
          <CardHeading>{t('coach.objections')}</CardHeading>
          <ul className="space-y-3">{r.objectionTips.map((o, i) => (
            <li key={i}><p className="font-medium">«{o.objection}»</p><p className="text-fg-sub">{o.tip}</p><p className="text-xs text-fg-muted">{t('coach.source', { label: o.refLabel })}</p></li>
          ))}</ul>
        </Card>
      )}
      <Card className="p-5">
        <MetricGrid metrics={r.metrics} median={r.team} />
        <p className="mt-3 text-xs text-fg-muted">{t('coach.numbersNote')}</p>
      </Card>
      {r.dropped.length > 0 && <Alert tone="info">{t('coach.dropped', { n: r.dropped.length })}</Alert>}
    </div>
  );
}

function Coach() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const ai = useAiStatus();
  const report = params.get('report');
  const [view, setView] = useState<View>(report ? 'reports' : 'mine');
  const [days, setDays] = useState<7 | 30>(7);
  const team = can('reports.read');
  const mine = useQuery({ queryKey: ['coach', 'me', days], queryFn: () => api<CoachTeamDto>(`/coach/me?days=${days}`), enabled: view === 'mine' });
  const all = useQuery({ queryKey: ['coach', 'team', days], queryFn: () => api<CoachTeamDto>(`/coach/team?days=${days}`), enabled: team && view === 'team' });
  const reports = useQuery({ queryKey: ['coach-reports'], queryFn: () => api<CoachReportSummaryDto[]>('/coach/reports'), enabled: view === 'reports' });
  const generate = useMutation({
    mutationFn: (membershipId?: string) => api<CoachReportDto>('/coach/reports', { method: 'POST', body: { membershipId, days } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['coach-reports'] });
      void qc.invalidateQueries({ queryKey: ['ai-status'] });
      open(r.id);
    },
  });
  const open = (id: string | null) => {
    setView('reports');
    router.replace(id ? `/coach?report=${id}` : '/coach');
  };
  if (!can('crm.visit.read')) return <NoPermission />;
  const aiReady = !!ai.data?.available && !!ai.data.agents?.sales_coach?.enabled && can('ai.use');
  const fmt = (k: CoachMetric, v: number) => (k === 'won_amount' ? formatMoney(v, locale) : k === 'visit_completion_pct' ? `${v}%` : String(v));

  const periodSwitch = (
    <div className="inline-grid grid-cols-2 gap-1 rounded-lg bg-subtle-strong p-1" role="radiogroup" aria-label={t('coach.period.7')}>
      {([7, 30] as const).map((d) => (
        <button key={d} role="radio" aria-checked={days === d} onClick={() => setDays(d)}
          className={cx('min-h-9 rounded-md px-3 text-sm', days === d ? 'bg-surface font-medium shadow-xs' : 'text-fg-muted hover:text-fg')}>
          {t(`coach.period.${d}`)}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <PageHeader title={t('coach.title')} subtitle={t('coach.subtitle')} />
      <Tabs<View>
        tabs={[{ id: 'mine', label: t('coach.tab.mine') }, ...(team ? [{ id: 'team' as View, label: t('coach.tab.team') }] : []), { id: 'reports', label: t('coach.tab.reports') }]}
        value={view} onChange={(v) => { setView(v); if (report) router.replace('/coach'); }} label={t('coach.title')}
      />
      {generate.error && <div className="mb-4"><Alert tone="error">{err(generate.error)}</Alert></div>}

      {view === 'mine' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {periodSwitch}
            {mine.data && <p className="text-sm text-fg-muted">{t('coach.periodRange', { from: formatDate(`${mine.data.from}T12:00:00Z`, locale), to: formatDate(`${mine.data.to}T12:00:00Z`, locale) })}</p>}
          </div>
          {mine.isLoading ? <LoadingState card /> : mine.error ? <ErrorState error={mine.error} /> : mine.data!.members[0] ? (
            <MetricGrid metrics={mine.data!.members[0].metrics} median={mine.data!.median} />
          ) : null}
          {can('ai.use') && (
            <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
              <div className="space-y-1">
                <AiNotice status={ai.data} />
                <p className="text-sm text-fg-muted">{t('coach.costNote')}</p>
              </div>
              <Button icon="sparkle" loading={generate.isPending} disabled={!aiReady} onClick={() => generate.mutate(undefined)}>{t('coach.generate')}</Button>
            </Card>
          )}
        </div>
      )}

      {view === 'team' && team && (
        <div className="space-y-4">
          {periodSwitch}
          {all.isLoading ? <LoadingState card /> : all.error ? <ErrorState error={all.error} /> : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-sm">
                  <thead className="text-xs text-fg-muted">
                    <tr>
                      <th className="px-4 py-3 text-start font-medium">{t('coach.member')}</th>
                      {KEY_METRICS.map((k) => <th key={k} className="px-2 py-3 text-end font-medium">{t(`coach.metric.${k}` as MessageKey)}</th>)}
                      <th className="w-40" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {all.data!.members.map((m) => (
                      <tr key={m.membershipId}>
                        <td className="px-4 py-3"><p className="font-medium">{m.name}{m.membershipId === me.data?.activeTenant?.membershipId ? ` (${t('coach.you')})` : ''}</p><p className="text-xs text-fg-muted">{t(`role.${m.role}` as MessageKey)}</p></td>
                        {KEY_METRICS.map((k) => <td key={k} className="px-2 text-end tabular-nums">{fmt(k, m.metrics[k])}</td>)}
                        <td className="px-3 text-end">
                          {can('ai.use') && <Button variant="ghost" icon="sparkle" className="min-h-9" disabled={!aiReady || generate.isPending} loading={generate.isPending && generate.variables === m.membershipId} aria-label={t('coach.generateFor', { name: m.name })} onClick={() => generate.mutate(m.membershipId)}>{t('coach.newReport')}</Button>}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-subtle font-medium">
                      <td className="px-4 py-3">{t('coach.median')}</td>
                      {KEY_METRICS.map((k) => <td key={k} className="px-2 text-end tabular-nums">{fmt(k, all.data!.median[k])}</td>)}
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <p className="text-xs text-fg-muted">{t('coach.numbersNote')} {can('ai.use') && t('coach.costNote')}</p>
        </div>
      )}

      {view === 'reports' && (report ? <ReportView id={report} onBack={() => open(null)} /> : reports.isLoading ? <LoadingState card /> : !reports.data?.length ? (
        <EmptyState icon="chart">{t('coach.empty')}</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line-soft">
            {reports.data.map((r) => (
              <li key={r.id}>
                <button onClick={() => open(r.id)} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-start transition-colors hover:bg-subtle">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{r.memberName}</span>
                    <span className="line-clamp-1 block text-sm text-fg-sub">{r.headline || '—'}</span>
                  </span>
                  {r.trigger === 'schedule' && <Badge tone="accent">{t('coach.byScheduler')}</Badge>}
                  <span className="text-xs text-fg-muted">{formatDate(r.createdAt, locale)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

export default function CoachPage() {
  return <Suspense fallback={<LoadingState card />}><Coach /></Suspense>;
}
