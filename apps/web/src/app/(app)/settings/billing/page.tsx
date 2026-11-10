'use client';

import { useQuery } from '@tanstack/react-query';
import type { TenantPlanDto } from '@rakan/shared';
import { Alert, Badge, Card, CardHeading, ErrorState, LoadingState, Meter, NoPermission, PageHeader, formatBytes, formatDate, formatUsd } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

/** The company's plan and how much of it is used (hard limits apply at 100%). */
export default function BillingPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const q = useQuery({ queryKey: ['tenant-plan'], queryFn: () => api<TenantPlanDto>('/tenant/plan'), enabled: can('tenant.settings.read') });
  if (!can('tenant.settings.read')) return <NoPermission />;
  if (q.isLoading) return <LoadingState card rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const L = d.plan?.limits;
  const daysLeft = d.trialEndsAt ? Math.ceil((new Date(d.trialEndsAt).getTime() - Date.now()) / 86400_000) : null;

  return (
    <>
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card className="h-fit p-5 sm:p-6">
          <p className="text-sm text-fg-muted">{t('billing.currentPlan')}</p>
          <p className="mt-1 font-display text-3xl font-semibold text-heading">{d.plan ? (locale === 'ar' ? d.plan.nameAr : d.plan.nameEn) : '—'}</p>
          {d.plan && (
            <p className="mt-1 text-fg-sub">{d.plan.priceSarMonthly === null ? t('platform.plans.custom') : `${d.plan.priceSarMonthly} ${t('platform.sarMonth')}`}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge tone={d.status === 'active' ? 'success' : d.status === 'trial' ? 'accent' : 'danger'} dot>{t(`platform.status.${d.status}` as MessageKey)}</Badge>
            {d.status === 'trial' && daysLeft !== null && (
              <Badge tone={daysLeft <= 3 ? 'danger' : 'neutral'}>{daysLeft > 0 ? t('billing.trialDays', { n: daysLeft }) : t('billing.trialEnded')}</Badge>
            )}
          </div>
          {d.trialEndsAt && d.status === 'trial' && <p className="mt-3 text-sm text-fg-muted">{t('billing.trialEndsOn', { date: formatDate(d.trialEndsAt, locale) })}</p>}
          <p className="mt-4 border-t border-line-soft pt-4 text-sm text-fg-muted">{t('billing.upgradeHint')}</p>
        </Card>

        <Card className="space-y-5 p-5 sm:p-6">
          <CardHeading>{t('billing.usage')}</CardHeading>
          {d.alerts.some((a) => a.level === 'full') && <Alert tone="error">{t('billing.full')}</Alert>}
          {!d.alerts.some((a) => a.level === 'full') && d.alerts.length > 0 && <Alert tone="warn">{t('billing.near')}</Alert>}
          <Meter label={t('platform.metric.users')} used={d.usage.activeUsers} limit={L?.users ?? null} unlimitedLabel={t('platform.unlimited')} />
          <Meter label={t('platform.metric.ai')} used={d.usage.aiUsdMonth} limit={L?.aiMonthlyUsd ?? null} format={formatUsd} unlimitedLabel={t('platform.unlimited')} />
          <Meter label={t('platform.metric.storage')} used={d.usage.storageBytes / 1024 / 1024} limit={L?.storageMb ?? null} format={(n) => formatBytes(n * 1024 * 1024)} unlimitedLabel={t('platform.unlimited')} />
          <dl className="grid grid-cols-2 gap-3 border-t border-line-soft pt-4 text-sm sm:grid-cols-3">
            {([['accounts', d.usage.accounts], ['visits30d', d.usage.visits30d], ['aiRuns', d.usage.aiRunsMonth]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-fg-muted">{t(`platform.stat.${k}` as MessageKey)}</dt><dd className="font-display text-xl font-semibold">{v}</dd></div>
            ))}
          </dl>
          <p className="text-xs text-fg-muted">{t('billing.limitsNote')}</p>
        </Card>
      </div>
    </>
  );
}
