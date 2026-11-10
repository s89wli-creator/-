'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TENANT_STATUSES, type PlanDto, type PlatformAuditDto, type TenantAdminDto } from '@rakan/shared';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useToast } from '@/components/feedback';
import { AlertBadges, STATUS_TONE } from '@/components/platform/shared';
import {
  Alert, BackLink, Badge, Button, Card, CardHeading, ErrorState, Field, Input, LoadingState, Meter, Select, Textarea, formatBytes, formatDate, formatUsd,
} from '@/components/ui';
import { api } from '@/lib/api';
import { auditActionLabel, type MessageKey } from '@/lib/i18n';
import { useI18n } from '@/lib/providers';

type Detail = TenantAdminDto & { recentActions: PlatformAuditDto[] };
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const toIso = (v: FormDataEntryValue | null) => (v ? new Date(`${String(v)}T23:59:59+03:00`).toISOString() : null);

export default function PlatformTenantPage() {
  const { id } = useParams<{ id: string }>();
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const tenant = useQuery({ queryKey: ['platform-tenant', id], queryFn: () => api<Detail>(`/platform/tenants/${id}`) });
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<PlanDto[]>('/platform/plans') });
  const save = useMutation({
    mutationFn: (body: object) => api<Detail>(`/platform/tenants/${id}/subscription`, { method: 'PATCH', body }),
    onSuccess: (d) => {
      qc.setQueryData(['platform-tenant', id], d);
      void qc.invalidateQueries({ queryKey: ['platform-tenants'] });
      void qc.invalidateQueries({ queryKey: ['platform-overview'] });
      setConfirmSuspend(false);
      toast(t('common.saveSuccess'));
    },
  });

  if (tenant.isLoading) return <LoadingState card rows={5} />;
  if (tenant.error) return <ErrorState error={tenant.error} onRetry={() => tenant.refetch()} />;
  const d = tenant.data!;
  const L = d.plan?.limits;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const status = String(fd.get('status'));
    if ((status === 'suspended' || status === 'cancelled') && status !== d.status && !confirmSuspend) return setConfirmSuspend(true);
    save.mutate({
      planId: String(fd.get('planId')) || undefined, status, trialEndsAt: toIso(fd.get('trialEndsAt')), currentPeriodEnd: toIso(fd.get('currentPeriodEnd')),
      notes: String(fd.get('notes') ?? '').trim() || null, reason: String(fd.get('reason') ?? '').trim(),
    });
  }

  return (
    <>
      <BackLink href="/platform/tenants">{t('platform.nav.tenants')}</BackLink>
      <header className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{d.name}</h1>
          <p className="text-sm text-fg-muted">{d.ownerName ?? '—'} · <bdi>{d.ownerEmail ?? '—'}</bdi> · {t('platform.since', { date: formatDate(d.createdAt, locale) })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[d.status] ?? 'muted'} dot>{t(`platform.status.${d.status}` as MessageKey)}</Badge>
          <AlertBadges alerts={d.alerts} />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <div className="space-y-4">
          <Card className="space-y-4 p-5 sm:p-6">
            <CardHeading>{t('platform.usage')}</CardHeading>
            <Meter label={t('platform.metric.users')} used={d.usage.activeUsers} limit={L?.users ?? null} unlimitedLabel={t('platform.unlimited')} />
            <Meter label={t('platform.metric.ai')} used={d.usage.aiUsdMonth} limit={L?.aiMonthlyUsd ?? null} format={formatUsd} unlimitedLabel={t('platform.unlimited')} />
            <Meter label={t('platform.metric.storage')} used={d.usage.storageBytes / 1024 / 1024} limit={L?.storageMb ?? null} format={(n) => formatBytes(n * 1024 * 1024)} unlimitedLabel={t('platform.unlimited')} />
            <dl className="grid grid-cols-2 gap-3 border-t border-line-soft pt-4 text-sm sm:grid-cols-4">
              {([['accounts', d.usage.accounts], ['visits30d', d.usage.visits30d], ['aiRuns', d.usage.aiRunsMonth], ['pending', d.usage.pendingInvitations]] as const).map(([k, v]) => (
                <div key={k}><dt className="text-fg-muted">{t(`platform.stat.${k}` as MessageKey)}</dt><dd className="font-display text-xl font-semibold">{v}</dd></div>
              ))}
            </dl>
            <p className="text-xs text-fg-muted">{t('platform.privacy')}</p>
          </Card>

          <Card className="p-5 sm:p-6">
            <CardHeading>{t('platform.history')}</CardHeading>
            {d.recentActions.length ? (
              <ol className="divide-y divide-line-soft text-sm">
                {d.recentActions.map((a) => (
                  <li key={a.id} className="py-2.5">
                    <p className="font-medium">{auditActionLabel(locale, a.action)} <span className="font-normal text-fg-muted">· {a.actorName ?? '—'} · {formatDate(a.createdAt, locale, true)}</span></p>
                    {(a.after as { reason?: string } | null)?.reason && <p className="text-fg-sub">{(a.after as { reason: string }).reason}</p>}
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-fg-muted">{t('platform.noHistory')}</p>}
          </Card>
        </div>

        <Card className="h-fit p-5 sm:p-6">
          <CardHeading>{t('platform.subscription')}</CardHeading>
          <form key={`${d.status}-${d.plan?.id}-${d.trialEndsAt}`} onSubmit={submit} className="space-y-4">
            {save.error && <Alert tone="error">{err(save.error)}</Alert>}
            <Field label={t('platform.plan')} htmlFor="planId">
              <Select id="planId" name="planId" defaultValue={d.plan?.id ?? ''}>
                {plans.data?.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.isActive && p.id !== d.plan?.id}>
                    {locale === 'ar' ? p.nameAr : p.nameEn}{p.priceSarMonthly !== null ? ` — ${p.priceSarMonthly} ${t('platform.sarMonth')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('platform.status')} htmlFor="status">
              <Select id="status" name="status" defaultValue={d.status} onChange={() => setConfirmSuspend(false)}>
                {TENANT_STATUSES.map((s) => <option key={s} value={s}>{t(`platform.status.${s}` as MessageKey)}</option>)}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <Field label={t('platform.trialEnds')} htmlFor="trialEndsAt" optional>
                <Input id="trialEndsAt" name="trialEndsAt" type="date" dir="ltr" defaultValue={dateInput(d.trialEndsAt)} />
              </Field>
              <Field label={t('platform.periodEnd')} htmlFor="currentPeriodEnd" optional>
                <Input id="currentPeriodEnd" name="currentPeriodEnd" type="date" dir="ltr" defaultValue={dateInput(d.currentPeriodEnd)} />
              </Field>
            </div>
            <Field label={t('platform.notes')} htmlFor="notes" optional>
              <Textarea id="notes" name="notes" rows={2} maxLength={2000} defaultValue={d.notes ?? ''} />
            </Field>
            <Field label={t('platform.reason')} htmlFor="reason">
              <Input id="reason" name="reason" required minLength={3} maxLength={500} placeholder={t('platform.reasonHint')} />
            </Field>
            {confirmSuspend && <Alert tone="warn">{t('platform.suspendWarning')}</Alert>}
            <Button type="submit" className="w-full" variant={confirmSuspend ? 'danger-solid' : 'primary'} loading={save.isPending}>
              {t(confirmSuspend ? 'platform.confirmSuspend' : 'common.save')}
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
