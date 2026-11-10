'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { AGENTS, SCORING_CRITERIA, type AgentRunDto, type AgentStepDto, type AiSettingsDto, type ScoringCriterion } from '@rakan/shared';
import { useState } from 'react';
import { useToast } from '@/components/feedback';
import {
  Alert, Badge, Button, Card, ErrorState, Field, Input, LoadingState, Modal, NoPermission, PageHeader, CardHeading, cx, formatDate,
} from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage, type MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50', checked ? 'bg-brand-600' : 'bg-line-strong')}
    >
      <span className={cx('absolute top-1 size-5 rounded-full bg-surface shadow-xs transition-transform duration-200 start-1', checked ? 'translate-x-5 rtl:-translate-x-5' : '')} />
    </button>
  );
}

const RUN_TONE: Record<string, 'success' | 'danger' | 'warn' | 'muted'> = { succeeded: 'success', failed: 'danger', running: 'warn', awaiting_approval: 'warn', cancelled: 'muted' };

export default function AiSettingsPage() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const toast = useToast();
  const invalidate = useInvalidate();
  const manage = can('ai.manage');
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<AiSettingsDto>('/ai/settings'), enabled: manage });
  const runs = useQuery({ queryKey: ['ai-runs'], queryFn: () => api<AgentRunDto[]>('/ai/runs'), enabled: can('ai.runs.read') });
  const [runId, setRunId] = useState<string | null>(null);
  const run = useQuery({
    queryKey: ['ai-run', runId],
    queryFn: () => api<AgentRunDto & { steps: AgentStepDto[] }>(`/ai/runs/${runId}`),
    enabled: !!runId,
  });
  const [weights, setWeights] = useState<Record<ScoringCriterion, number> | null>(null);
  const saved = () => {
    toast(t('common.saveSuccess'));
    invalidate('ai-settings');
    invalidate('ai-status');
  };
  const update = useMutation({ mutationFn: (body: object) => api<AiSettingsDto>('/ai/settings', { method: 'PATCH', body }), onSuccess: saved });
  const scoring = useMutation({
    mutationFn: (body: object) => api<AiSettingsDto>('/ai/scoring', { method: 'PUT', body }),
    onSuccess: () => {
      setWeights(null);
      saved();
    },
  });

  if (!manage && !can('ai.runs.read')) return <NoPermission />;

  const runsCard = (
    <Card className="p-5 sm:p-6">
      <CardHeading>{t('ai.runs.title')}</CardHeading>
      <p className="mb-3 text-sm text-fg-muted">{t('ai.runs.hint')}</p>
      {runs.isLoading ? <LoadingState rows={4} /> : runs.data?.length ? (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-start text-xs text-fg-muted">
              <tr><th className="px-2 py-2 text-start font-medium">{t('ai.runs.agent')}</th><th className="px-2 text-start font-medium">{t('ai.runs.by')}</th><th className="px-2 text-start font-medium">{t('ai.runs.status')}</th><th className="px-2 text-end font-medium">{t('ai.runs.cost')}</th><th className="px-2 text-end font-medium">{t('ai.runs.when')}</th></tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {runs.data.map((r) => (
                <tr key={r.id} className="cursor-pointer transition-colors hover:bg-subtle" onClick={() => setRunId(r.id)}>
                  <td className="px-2 py-2.5"><button className="text-start font-medium text-brand-700 hover:underline">{t(`ai.agent.${r.agent}` as MessageKey)}</button></td>
                  <td className="px-2">{r.triggeredByName ?? '—'}</td>
                  <td className="px-2"><Badge tone={RUN_TONE[r.status] ?? 'muted'} dot>{t(`ai.runs.s.${r.status}` as MessageKey)}</Badge></td>
                  <td className="px-2 text-end tabular-nums" dir="ltr">{usd(r.costUsd)}</td>
                  <td className="px-2 text-end text-fg-muted">{formatDate(r.startedAt, locale, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-sm text-fg-muted">{t('ai.runs.empty')}</p>}
    </Card>
  );

  if (!manage) return <><PageHeader title={t('ai.settings.title')} />{runsCard}</>;
  if (settings.isLoading) return <LoadingState card />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const s = settings.data!;
  const w = weights ?? s.scoring.weights;
  const total = SCORING_CRITERIA.reduce((a, k) => a + (w[k] ?? 0), 0);
  const ratio = s.usage.budgetUsd > 0 ? Math.min(1, s.usage.monthUsd / s.usage.budgetUsd) : 1;

  return (
    <>
      <PageHeader title={t('ai.settings.title')} subtitle={t('ai.settings.subtitle')} />
      <div className="space-y-5">
        {!s.usage.providerReady && <Alert tone="warn">{t('ai.notice.notConfigured')}</Alert>}
        {(update.error || scoring.error) && <Alert tone="error">{err(update.error ?? scoring.error)}</Alert>}

        <Card className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">{t('ai.settings.enabled')}</h2>
              <p className="text-sm text-fg-muted">{t('ai.settings.enabledHint')}</p>
            </div>
            <Switch checked={s.enabled} label={t('ai.settings.enabled')} disabled={update.isPending} onChange={(v) => update.mutate({ enabled: v })} />
          </div>
          <ul className="mt-4 divide-y divide-line-soft border-t border-line-soft">
            {AGENTS.map((a) => (
              <li key={a} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="font-medium">{t(`ai.agent.${a}` as MessageKey)}</p>
                  <p className="text-sm text-fg-muted">{t(`ai.agentHint.${a}` as MessageKey)}</p>
                </div>
                <Switch checked={s.agents[a].enabled} label={t(`ai.agent.${a}` as MessageKey)} disabled={!s.enabled || update.isPending} onChange={(v) => update.mutate({ agents: { [a]: { enabled: v } } })} />
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeading>{t('ai.usage.title')}</CardHeading>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-2xl font-semibold tabular-nums" dir="ltr">{usd(s.usage.monthUsd)} <span className="text-base font-normal text-fg-muted">/ {usd(s.usage.budgetUsd)}</span></p>
            <p className="text-sm text-fg-muted">{t('ai.usage.runs', { n: s.usage.runsThisMonth })}</p>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-subtle-strong" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className={cx('h-full origin-right ltr:origin-left rounded-full transition-transform duration-300', ratio >= 1 ? 'bg-danger' : ratio >= 0.8 ? 'bg-warn' : 'bg-brand-600')} style={{ transform: `scaleX(${ratio})` }} />
          </div>
          {ratio >= 0.8 && <div className="mt-3"><Alert tone={ratio >= 1 ? 'error' : 'warn'}>{t(ratio >= 1 ? 'ai.usage.reached' : 'ai.usage.near')}</Alert></div>}
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ monthlyBudgetUsd: Number(new FormData(e.currentTarget).get('budget')) });
            }}
          >
            <Field label={t('ai.usage.budget')} htmlFor="ai-budget">
              <Input id="ai-budget" name="budget" type="number" min={0} max={100000} step="1" dir="ltr" defaultValue={s.monthlyBudgetUsd} className="w-40" />
            </Field>
            <Button type="submit" variant="secondary" loading={update.isPending}>{t('common.save')}</Button>
          </form>
          <p className="mt-3 text-xs text-fg-muted">{t('ai.usage.note')}</p>
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeading>{t('ai.scoring.title')}</CardHeading>
          <p className="mb-4 text-sm text-fg-muted">{t('ai.scoring.hint', { v: s.scoring.version })}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SCORING_CRITERIA.map((k) => (
              <Field key={k} label={t(`ai.criterion.${k}` as MessageKey)} htmlFor={`w-${k}`}>
                <Input id={`w-${k}`} type="number" min={0} max={100} dir="ltr" value={w[k]} onChange={(e) => setWeights({ ...w, [k]: Number(e.target.value) || 0 })} />
              </Field>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className={cx('text-sm font-medium', total === 100 ? 'text-success' : 'text-danger')}>{t('ai.scoring.total', { n: total })}</p>
            <Button disabled={!weights || total !== 100} loading={scoring.isPending} onClick={() => scoring.mutate({ weights: w, tierThresholds: s.scoring.tierThresholds })}>{t('common.save')}</Button>
          </div>
          <p className="mt-2 text-xs text-fg-muted">{t('ai.scoring.tiers', s.scoring.tierThresholds)}</p>
        </Card>

        {can('ai.runs.read') && runsCard}
      </div>

      <Modal open={!!runId} onClose={() => setRunId(null)} title={t('ai.runs.detail')} size="lg">
        {run.isLoading || !run.data ? <LoadingState rows={4} /> : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge>{t(`ai.agent.${run.data.agent}` as MessageKey)}</Badge>
              <Badge tone={RUN_TONE[run.data.status] ?? 'muted'} dot>{t(`ai.runs.s.${run.data.status}` as MessageKey)}</Badge>
              {run.data.model && <Badge tone="muted"><bdi dir="ltr">{run.data.model}</bdi></Badge>}
            </div>
            <p dir="ltr" className="text-end tabular-nums text-fg-muted">{run.data.inputTokens.toLocaleString()} in · {run.data.outputTokens.toLocaleString()} out · {usd(run.data.costUsd)}</p>
            {run.data.error && <Alert tone="error">{errorMessage(locale, run.data.error.code)}</Alert>}
            <ol className="space-y-2">
              {run.data.steps.map((st) => (
                <li key={st.id} className="rounded-lg border border-line-soft p-3">
                  <p className="font-medium">{t(`ai.step.${st.kind}` as MessageKey)} <span className="text-xs font-normal text-fg-muted">· {formatDate(st.createdAt, locale, true)}</span></p>
                  <pre className="mt-1 overflow-x-auto text-xs text-fg-muted" dir="ltr">{JSON.stringify(st.detail)}</pre>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Modal>
    </>
  );
}
