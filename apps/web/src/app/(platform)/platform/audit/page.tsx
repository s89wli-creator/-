'use client';

import { useQuery } from '@tanstack/react-query';
import type { PlatformAuditDto } from '@rakan/shared';
import Link from 'next/link';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { auditActionLabel } from '@/lib/i18n';
import { useI18n } from '@/lib/providers';

export default function PlatformAuditPage() {
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ['platform-audit'], queryFn: () => api<PlatformAuditDto[]>('/platform/audit') });
  if (q.isLoading) return <LoadingState card />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <PageHeader title={t('platform.audit.title')} subtitle={t('platform.audit.subtitle')} />
      {!q.data!.length ? <EmptyState icon="list">{t('platform.noHistory')}</EmptyState> : (
        <Card>
          <ol className="divide-y divide-line-soft text-sm">
            {q.data!.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {auditActionLabel(locale, a.action)}
                    {a.tenantId && <> · <Link href={`/platform/tenants/${a.tenantId}`} className="text-brand-700 hover:underline">{a.tenantName ?? '—'}</Link></>}
                  </p>
                  {(a.after as { reason?: string } | null)?.reason && <p className="text-fg-sub">{(a.after as { reason: string }).reason}</p>}
                </div>
                <span className="text-xs text-fg-muted">{a.actorName ?? '—'} · {formatDate(a.createdAt, locale, true)}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
