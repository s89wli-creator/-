'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobDto, JobKeyDto, JobRunDto } from '@rakan/shared';
import { useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, CardHeading, ErrorState, LoadingState, NoPermission, PageHeader, cx, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';
import { useAiStatus } from '@/components/ai/panels';

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const STATUS_TONE = { succeeded: 'success', failed: 'danger', skipped: 'muted' } as const;
const pad = (n: number) => String(n).padStart(2, '0');

function useDetail() {
  const { t } = useI18n();
  return (d: Record<string, unknown> | null) => {
    if (!d) return '';
    const parts: string[] = [];
    for (const k of ['notified', 'emailed', 'prepared', 'reports', 'failed'] as const) if (typeof d[k] === 'number') parts.push(t(`auto.detail.${k}` as MessageKey, { n: d[k] as number }));
    for (const k of ['reason', 'stopped'] as const) if (typeof d[k] === 'string') parts.push(t(`auto.reason.${d[k]}` as MessageKey));
    return parts.join(' · ');
  };
}

function JobCard({ job, aiReady }: { job: JobDto; aiReady: boolean }) {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const detail = useDetail();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['automation'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const save = useMutation({
    mutationFn: (body: Partial<Pick<JobDto, 'enabled' | 'hour' | 'minute' | 'days' | 'email'>>) => api<JobDto>(`/automation/jobs/${job.job}`, { method: 'PATCH', body }),
    onSuccess: () => { refresh(); toast(t('auto.saved')); },
  });
  const run = useMutation({
    mutationFn: () => api<JobRunDto>(`/automation/jobs/${job.job}/run`, { method: 'POST' }),
    onSuccess: (r) => { refresh(); toast(`${t('auto.ran')}: ${t(`auto.status.${r.status}`)}${detail(r.detail) ? ` · ${detail(r.detail)}` : ''}`, r.status === 'failed' ? 'error' : undefined); },
  });
  const busy = save.isPending || run.isPending;
  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold">
            {t(`auto.job.${job.job}` as MessageKey)}
            {job.usesAi && <Badge tone="accent"><Icon name="sparkle" size={16} /> {t('auto.usesAi')}</Badge>}
          </h2>
          <p className="text-sm text-fg-muted">{t(`auto.desc.${job.job}` as MessageKey)}</p>
        </div>
        <button
          type="button" role="switch" aria-checked={job.enabled} aria-label={`${t(`auto.job.${job.job}` as MessageKey)}: ${t('auto.enabled')}`} disabled={busy}
          onClick={() => save.mutate({ enabled: !job.enabled })}
          className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', job.enabled ? 'bg-brand-600' : 'bg-line')}
        >
          <span className={cx('absolute top-0.5 size-6 rounded-full bg-white shadow transition-[inset-inline-start]', job.enabled ? 'start-[1.375rem]' : 'start-0.5')} />
        </button>
      </div>
      {(save.error || run.error) && <Alert tone="error">{err(save.error ?? run.error)}</Alert>}
      {job.usesAi && !aiReady && <Alert tone="warn">{t('auto.aiNotReady')}</Alert>}

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-fg-muted">{t('auto.time')}</span>
          <input
            type="time" dir="ltr" defaultValue={`${pad(job.hour)}:${pad(job.minute)}`} disabled={busy}
            className="min-h-11 rounded-lg border border-line bg-surface px-3"
            onBlur={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (Number.isFinite(h) && Number.isFinite(m) && (h !== job.hour || m !== job.minute)) save.mutate({ hour: h, minute: m });
            }}
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-xs text-fg-muted">{t('auto.days')}</legend>
          <div className="flex flex-wrap gap-1">
            {DAYS.map((d) => {
              const on = job.days.includes(d);
              return (
                <button key={d} type="button" aria-pressed={on} disabled={busy || (on && job.days.length === 1)}
                  onClick={() => save.mutate({ days: on ? job.days.filter((x) => x !== d) : [...job.days, d] })}
                  className={cx('min-h-9 rounded-full border px-3 text-xs transition-colors disabled:opacity-60', on ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-line text-fg-sub hover:border-brand-600')}>
                  {t(`day.${d}` as MessageKey)}
                </button>
              );
            })}
          </div>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand-600)]" checked={job.email} disabled={busy} onChange={(e) => save.mutate({ email: e.target.checked })} />
          {t('auto.email')}
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3 text-sm text-fg-muted">
        <div className="space-y-0.5">
          {job.enabled && job.nextRunAt && <p>{t('auto.next', { at: formatDate(job.nextRunAt, locale, true) })}</p>}
          {job.lastRunAt && (
            <p className="flex flex-wrap items-center gap-1.5">
              {t('auto.last', { at: formatDate(job.lastRunAt, locale, true) })}
              {job.lastStatus && <Badge tone={STATUS_TONE[job.lastStatus]} dot>{t(`auto.status.${job.lastStatus}`)}</Badge>}
              <span>{detail(job.lastDetail)}</span>
            </p>
          )}
        </div>
        <Button variant="secondary" icon="sparkle" loading={run.isPending} disabled={busy} onClick={() => run.mutate()}>{t('auto.runNow')}</Button>
      </div>
    </Card>
  );
}

export default function AutomationPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const ai = useAiStatus();
  const detail = useDetail();
  const jobs = useQuery({ queryKey: ['automation', 'jobs'], queryFn: () => api<JobDto[]>('/automation/jobs'), enabled: can('crm.settings.manage') });
  const runs = useQuery({ queryKey: ['automation', 'runs'], queryFn: () => api<JobRunDto[]>('/automation/runs'), enabled: can('crm.settings.manage') });
  if (!can('crm.settings.manage')) return <NoPermission />;
  if (jobs.isLoading) return <LoadingState card />;
  if (jobs.error) return <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />;
  const aiReady = !!ai.data?.providerReady && !!ai.data.enabled;
  return (
    <>
      <PageHeader title={t('auto.title')} subtitle={t('auto.subtitle')} />
      <div className="space-y-4">
        {jobs.data!.map((j) => <JobCard key={j.job} job={j} aiReady={aiReady} />)}
        <Card className="p-5 sm:p-6">
          <CardHeading>{t('auto.history')}</CardHeading>
          {runs.data?.length ? (
            <ul className="divide-y divide-line-soft text-sm">
              {runs.data.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <span className="font-medium">{t(`auto.job.${r.job as JobKeyDto}` as MessageKey)}</span>
                  <Badge tone={STATUS_TONE[r.status]} dot>{t(`auto.status.${r.status}`)}</Badge>
                  <span className="text-fg-muted">{detail(r.detail)}</span>
                  <span className="ms-auto text-xs text-fg-muted">{t(`auto.trigger.${r.trigger}`)}{r.triggeredByName ? ` · ${r.triggeredByName}` : ''} · {formatDate(r.startedAt, locale, true)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-fg-muted">{t('auto.noRuns')}</p>}
        </Card>
      </div>
    </>
  );
}
