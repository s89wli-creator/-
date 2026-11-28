'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingInvoiceDto, BillingOverviewDto, BillingPeriod, CheckoutDto } from '@rakan/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, CardHeading, LoadingState, cx, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

const sar = (n: number, locale: 'ar' | 'en') =>
  `${new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${locale === 'ar' ? 'ر.س' : 'SAR'}`;
const TONE: Record<BillingInvoiceDto['status'], 'accent' | 'success' | 'danger' | 'muted'> = { pending: 'accent', paid: 'success', failed: 'danger', expired: 'muted', canceled: 'muted' };

/** Plans and online payment (Moyasar hosted page), plus the payment history. */
export function Subscribe() {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [period, setPeriod] = useState<BillingPeriod>('month');
  const q = useQuery({ queryKey: ['billing'], queryFn: () => api<BillingOverviewDto>('/billing') });
  const checkout = useMutation({
    mutationFn: (planKey: string) => api<CheckoutDto>('/billing/checkout', { method: 'POST', body: { planKey, period } }),
    onSuccess: (c) => { window.location.assign(c.paymentUrl); },
  });
  const verify = useMutation({
    mutationFn: (id: string) => api<BillingInvoiceDto>(`/billing/invoices/${id}/verify`, { method: 'POST' }),
    onSuccess: (inv) => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      void qc.invalidateQueries({ queryKey: ['tenant-plan'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast(t(inv.status === 'paid' ? 'pay.paidToast' : inv.status === 'pending' ? 'pay.pendingToast' : 'pay.canceledToast'), inv.status === 'paid' ? 'success' : 'info');
    },
  });

  // Back from Moyasar: check the payment once, then clean the address bar.
  const handled = useRef(false);
  useEffect(() => {
    const id = params.get('invoice');
    if (!id || handled.current) return;
    handled.current = true;
    if (params.get('canceled')) toast(t('pay.canceledToast'), 'info');
    else verify.mutate(id);
    router.replace('/settings/billing');
  }, [params, router, toast, t, verify]);

  if (q.isLoading) return <LoadingState card rows={3} />;
  if (!q.data) return null;
  const d = q.data;
  const hasYearly = d.plans.some((p) => p.priceYearly !== null);
  const wasSuspended = d.subscription.status === 'suspended' || d.subscription.status === 'cancelled';

  return (
    <div className="mt-5 space-y-4">
      <Card className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardHeading>{t('pay.title')}</CardHeading>
          {hasYearly && (
            <div className="inline-grid grid-cols-2 gap-1 rounded-lg bg-subtle-strong p-1" role="radiogroup" aria-label={t('pay.title')}>
              {(['month', 'year'] as const).map((p) => (
                <button key={p} role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}
                  className={cx('min-h-9 rounded-md px-4 text-sm', period === p ? 'bg-surface font-medium shadow-xs' : 'text-fg-muted hover:text-fg')}>
                  {t(p === 'month' ? 'pay.monthly' : 'pay.yearly')}
                </button>
              ))}
            </div>
          )}
        </div>
        {d.subscription.paidUntil && <p className="text-sm text-fg-sub">{t('pay.paidUntil', { date: formatDate(d.subscription.paidUntil, locale) })}</p>}
        {d.subscription.needsPayment && <Alert tone="warn">{t('pay.needsPayment')}</Alert>}
        {wasSuspended && d.invoices.some((i) => i.status === 'paid') && <Alert tone="info">{t('pay.suspendedPaid')}</Alert>}
        {!d.providerReady && <Alert tone="info">{t('pay.notReady')}</Alert>}
        {d.providerReady && !d.canPay && <Alert tone="info">{t('pay.ownerOnly')}</Alert>}
        {(checkout.error || verify.error) && <Alert tone="error">{err(checkout.error ?? verify.error)}</Alert>}
        {verify.isPending && <p role="status" className="text-sm text-fg-muted">{t('pay.checking')}</p>}

        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {d.plans.map((p) => {
            const price = period === 'month' ? p.priceMonthly : p.priceYearly;
            const withVat = price !== null ? Math.round(price * 1.15 * 100) / 100 : null;
            return (
              <li key={p.key} className={cx('flex flex-col rounded-xl border p-4', p.current ? 'border-brand-600 bg-brand-50/50' : 'border-line bg-surface')}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-display text-lg font-semibold">{locale === 'ar' ? p.nameAr : p.nameEn}</p>
                  {p.current && <Badge tone="brand">{t('pay.current')}</Badge>}
                </div>
                {p.priceMonthly === null ? (
                  <p className="mt-2 text-sm text-fg-muted">{t('platform.plans.custom')}</p>
                ) : price === null ? (
                  <p className="mt-2 text-sm text-fg-muted">{t('pay.noYearly')}</p>
                ) : (
                  <>
                    <p className="mt-2"><span className="font-display text-2xl font-bold tabular-nums">{sar(price, locale)}</span> <span className="text-sm text-fg-muted">{t(period === 'month' ? 'pay.perMonth' : 'pay.perYear')}</span></p>
                    <p className="text-xs text-fg-muted">{t('pay.withVat', { amount: sar(withVat!, locale) })}</p>
                  </>
                )}
                <div className="mt-auto pt-4">
                  {price !== null && p.priceMonthly !== null ? (
                    <Button className="w-full" variant={p.current ? 'primary' : 'secondary'} icon="lock" disabled={!d.canPay || checkout.isPending}
                      loading={checkout.isPending && checkout.variables === p.key} onClick={() => checkout.mutate(p.key)}>
                      {checkout.isPending && checkout.variables === p.key ? t('pay.redirecting') : p.current ? t('pay.renew') : t('pay.choose')}
                    </Button>
                  ) : <p className="text-center text-xs text-fg-muted">{t('pay.contact')}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="flex items-start gap-1.5 text-xs text-fg-muted"><Icon name="lock" size={16} className="shrink-0" /> {t('pay.secure')} {t('pay.vatNote')}</p>
        <p className="text-xs text-fg-muted">{t('pay.switchNote')}</p>
      </Card>

      <Card className="p-5 sm:p-6">
        <CardHeading>{t('pay.history')}</CardHeading>
        {!d.invoices.length ? <p className="text-sm text-fg-muted">{t('pay.noInvoices')}</p> : (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-xs text-fg-muted">
                <tr>
                  <th className="px-2 py-2 text-start font-medium">{t('pay.number')}</th>
                  <th className="px-2 text-start font-medium">{t('pay.plan')}</th>
                  <th className="px-2 text-start font-medium">{t('pay.period')}</th>
                  <th className="px-2 text-end font-medium">{t('pay.total')}</th>
                  <th className="px-2 text-start font-medium">{t('pay.status')}</th>
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {d.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="px-2 py-2.5" dir="ltr">{i.number}</td>
                    <td className="px-2">{i.planName} · {t(i.period === 'month' ? 'pay.monthly' : 'pay.yearly')}</td>
                    <td className="px-2 text-xs text-fg-muted">{formatDate(i.periodStart, locale)} – {formatDate(i.periodEnd, locale)}</td>
                    <td className="px-2 text-end tabular-nums">{sar(i.total, locale)}</td>
                    <td className="px-2"><Badge tone={TONE[i.status]} dot>{t(`pay.status.${i.status}`)}</Badge></td>
                    <td className="px-2 text-end">
                      {i.status === 'paid' && <Link href={`/print/receipts/${i.id}`} className="text-brand-700 hover:underline">{t('pay.receipt')}</Link>}
                      {i.status === 'pending' && (
                        <span className="inline-flex gap-2">
                          {i.paymentUrl && d.canPay && <a href={i.paymentUrl} className="text-brand-700 hover:underline">{t('pay.complete')}</a>}
                          <button className="text-fg-sub hover:underline" disabled={verify.isPending} onClick={() => verify.mutate(i.id)}>{t('pay.verify')}</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
