'use client';

import { useQuery } from '@tanstack/react-query';
import type { BillingInvoiceDto } from '@rakan/shared';
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

const TONE: Record<BillingInvoiceDto['status'], 'accent' | 'success' | 'danger' | 'muted'> = { pending: 'accent', paid: 'success', failed: 'danger', expired: 'muted', canceled: 'muted' };

/** Platform console: every subscription payment, as confirmed with EdfaPay. */
export default function PlatformPaymentsPage() {
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ['platform-payments'], queryFn: () => api<BillingInvoiceDto[]>('/platform/billing/invoices') });
  if (q.isLoading) return <LoadingState card />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!;
  const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z').getTime();
  const collected = rows.filter((r) => r.status === 'paid' && r.paidAt && new Date(r.paidAt).getTime() >= monthStart).reduce((a, r) => a + r.total, 0);
  const sar = (n: number) => `${new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${locale === 'ar' ? 'ر.س' : 'SAR'}`;
  return (
    <>
      <PageHeader title={t('platform.payments.title')} subtitle={t('platform.payments.subtitle')} />
      <Card className="mb-4 p-5">
        <p className="text-sm text-fg-muted">{t('platform.payments.paidThisMonth')}</p>
        <p className="font-display text-3xl font-semibold tabular-nums">{sar(collected)}</p>
      </Card>
      {!rows.length ? <EmptyState icon="list">{t('pay.noInvoices')}</EmptyState> : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="text-xs text-fg-muted">
                <tr>
                  <th className="px-4 py-3 text-start font-medium">{t('pay.number')}</th>
                  <th className="px-2 text-start font-medium">{t('platform.payments.company')}</th>
                  <th className="px-2 text-start font-medium">{t('pay.plan')}</th>
                  <th className="px-2 text-end font-medium">{t('pay.total')}</th>
                  <th className="px-2 text-start font-medium">{t('pay.status')}</th>
                  <th className="px-4 text-end font-medium">{t('receipt.paidOn')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5" dir="ltr">{r.number}</td>
                    <td className="px-2">{r.tenantName}</td>
                    <td className="px-2">{r.planName} · {t(r.period === 'month' ? 'pay.monthly' : 'pay.yearly')}</td>
                    <td className="px-2 text-end tabular-nums">{sar(r.total)}</td>
                    <td className="px-2"><Badge tone={TONE[r.status]} dot>{t(`pay.status.${r.status}`)}</Badge></td>
                    <td className="px-4 text-end text-xs text-fg-muted">{r.paidAt ? formatDate(r.paidAt, locale, true) : formatDate(r.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
