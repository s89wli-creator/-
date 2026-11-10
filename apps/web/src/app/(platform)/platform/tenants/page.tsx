'use client';

import { useQuery } from '@tanstack/react-query';
import { TENANT_STATUSES, type TenantAdminDto } from '@rakan/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AlertBadges, STATUS_TONE } from '@/components/platform/shared';
import { Badge, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, formatBytes, formatDate, formatUsd } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/lib/providers';

function TenantsList() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) }).toString();
  const list = useQuery({ queryKey: ['platform-tenants', qs], queryFn: () => api<TenantAdminDto[]>(`/platform/tenants${qs ? `?${qs}` : ''}`) });
  const setStatus = (s: string) => router.replace(`/platform/tenants${s ? `?status=${s}` : ''}`);

  return (
    <>
      <PageHeader title={t('platform.tenants.title')} subtitle={t('platform.tenants.subtitle')} />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('platform.tenants.search')} aria-label={t('platform.tenants.search')} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('platform.status')}>
          <option value="">{t('platform.allStatuses')}</option>
          {TENANT_STATUSES.map((s) => <option key={s} value={s}>{t(`platform.status.${s}` as MessageKey)}</option>)}
        </Select>
      </div>
      {list.isLoading ? <LoadingState card /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.length ? (
        <EmptyState icon="building">{t('platform.tenants.empty')}</EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b border-line-soft text-xs text-fg-muted">
              <tr>
                {(['name', 'plan', 'status', 'users', 'ai', 'storage', 'lastActivity', 'alerts'] as const).map((c) => (
                  <th key={c} className="px-4 py-3 text-start font-medium">{t(`platform.col.${c}` as MessageKey)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {list.data!.map((x) => (
                <tr key={x.id} className="transition-colors hover:bg-subtle">
                  <td className="px-4 py-3">
                    <Link href={`/platform/tenants/${x.id}`} className="font-semibold text-brand-700 hover:underline">{x.name}</Link>
                    <p className="text-xs text-fg-muted"><bdi>{x.ownerEmail ?? '—'}</bdi></p>
                  </td>
                  <td className="px-4 py-3">{x.plan ? (locale === 'ar' ? x.plan.nameAr : x.plan.nameEn) : '—'}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[x.status] ?? 'muted'} dot>{t(`platform.status.${x.status}` as MessageKey)}</Badge></td>
                  <td className="px-4 py-3 tabular-nums" dir="ltr">{x.usage.activeUsers}{x.plan?.limits.users != null && ` / ${x.plan.limits.users}`}</td>
                  <td className="px-4 py-3 tabular-nums" dir="ltr">{formatUsd(x.usage.aiUsdMonth)}{x.plan?.limits.aiMonthlyUsd != null && ` / ${formatUsd(x.plan.limits.aiMonthlyUsd)}`}</td>
                  <td className="px-4 py-3 tabular-nums" dir="ltr">{formatBytes(x.usage.storageBytes)}</td>
                  <td className="px-4 py-3 text-fg-muted">{x.usage.lastActivityAt ? formatDate(x.usage.lastActivityAt, locale) : '—'}</td>
                  <td className="px-4 py-3"><AlertBadges alerts={x.alerts} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

export default function PlatformTenantsPage() {
  return (
    <Suspense fallback={<LoadingState card />}>
      <TenantsList />
    </Suspense>
  );
}
