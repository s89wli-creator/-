'use client';

import { useQuery } from '@tanstack/react-query';
import type { PlatformOverviewDto } from '@rakan/shared';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { Card, CardHeading, ErrorState, LoadingState, PageHeader, formatBytes, formatMoney, formatUsd } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

function Kpi({ icon, label, value, hint, href }: { icon: IconName; label: string; value: string; hint?: string; href?: string }) {
  const body = (
    <Card className="h-full p-5" interactive={!!href}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-fg-muted">{label}</p>
        <span className="grid size-8 place-items-center rounded-lg bg-subtle-strong text-fg-sub" aria-hidden><Icon name={icon} size={16} /></span>
      </div>
      <p className="mt-2 font-display text-3xl font-semibold text-heading" dir="auto">{value}</p>
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </Card>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export default function PlatformOverviewPage() {
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ['platform-overview'], queryFn: () => api<PlatformOverviewDto>('/platform/overview') });
  if (q.isLoading) return <LoadingState card rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data!;
  return (
    <>
      <PageHeader title={t('platform.overview.title')} subtitle={t('platform.overview.subtitle')} />
      <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon="building" label={t('platform.kpi.tenants')} value={String(o.tenants.total)} hint={t('platform.kpi.tenantsHint', { trial: o.tenants.trial, active: o.tenants.active, suspended: o.tenants.suspended })} href="/platform/tenants" />
        <Kpi icon="chart" label={t('platform.kpi.mrr')} value={formatMoney(o.mrrSar, locale)} hint={t('platform.kpi.mrrHint')} />
        <Kpi icon="users" label={t('platform.kpi.users')} value={String(o.users)} hint={t('platform.kpi.new30d', { n: o.tenants.new30d })} />
        <Kpi icon="sparkle" label={t('platform.kpi.ai')} value={formatUsd(o.aiUsdMonth)} hint={t('platform.kpi.aiHint')} />
        <Kpi icon="calendar" label={t('platform.kpi.trialsEnding')} value={String(o.trialsEndingSoon)} hint={t('platform.kpi.trialsEndingHint')} href="/platform/tenants?status=trial" />
        <Kpi icon="alert" label={t('platform.kpi.alerts')} value={String(o.alerts)} hint={t('platform.kpi.alertsHint')} href="/platform/tenants" />
        <Kpi icon="upload" label={t('platform.kpi.storage')} value={formatBytes(o.storageBytes)} />
        <Kpi icon="lock" label={t('platform.kpi.suspended')} value={String(o.tenants.suspended + o.tenants.cancelled)} href="/platform/tenants?status=suspended" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-5 sm:p-6">
          <CardHeading>{t('platform.byPlan')}</CardHeading>
          <ul className="divide-y divide-line-soft">
            {o.byPlan.map((p) => (
              <li key={p.key} className="flex items-center justify-between py-2.5 text-sm">
                <span className="font-medium">{locale === 'ar' ? p.nameAr : p.nameEn}</span>
                <span className="tabular-nums text-fg-muted">{t('platform.tenantsCount', { n: p.tenants })}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5 sm:p-6">
          <CardHeading>{t('platform.topAi')}</CardHeading>
          {o.topAiSpend.length ? (
            <ul className="divide-y divide-line-soft">
              {o.topAiSpend.map((x) => (
                <li key={x.id} className="flex items-center justify-between py-2.5 text-sm">
                  <Link href={`/platform/tenants/${x.id}`} className="font-medium text-brand-700 hover:underline">{x.name}</Link>
                  <span className="tabular-nums" dir="ltr">{formatUsd(x.aiUsdMonth)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-fg-muted">{t('platform.noAiSpend')}</p>}
        </Card>
      </div>
      <p className="mt-6 flex items-center gap-2 text-xs text-fg-muted"><Icon name="lock" size={16} /> {t('platform.privacy')}</p>
    </>
  );
}
