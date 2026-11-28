'use client';

import { useQuery } from '@tanstack/react-query';
import type { BillingInvoiceDto } from '@rakan/shared';
import { use } from 'react';
import { Logo } from '@/components/brand/Logo';
import { Button, ErrorState, LoadingState, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

/** Printable payment receipt (not a tax invoice until ZATCA e-invoicing is connected). */
export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api<BillingInvoiceDto & { companyName: string }>(`/billing/invoices/${id}`) });
  if (q.isLoading) return <div className="p-8"><LoadingState card /></div>;
  if (q.error) return <div className="p-8"><ErrorState error={q.error} /></div>;
  const r = q.data!;
  const m = (n: number) => `${new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${locale === 'ar' ? 'ر.س' : 'SAR'}`;
  const Row = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
    <div className={`flex justify-between gap-4 py-2 ${strong ? 'border-t-2 border-petrol text-base font-bold' : 'border-b border-line-soft'}`}><span className={strong ? '' : 'text-fg-muted'}>{k}</span><span className="tabular-nums">{v}</span></div>
  );
  return (
    <div className="min-h-dvh bg-subtle py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-2xl justify-end px-4 print:hidden"><Button icon="printer" onClick={() => window.print()}>{t('proposal.print')}</Button></div>
      <article className="mx-auto max-w-2xl space-y-6 bg-surface p-8 print:p-0">
        <header className="flex items-start justify-between gap-4 border-b-2 border-petrol pb-5">
          <div><Logo height={34} label="راكان" /><p className="mt-2 text-sm text-fg-muted">{t('receipt.seller')}</p></div>
          <div className="text-end text-sm">
            <p className="font-display text-xl font-semibold">{t('receipt.title')}</p>
            <p dir="ltr">{r.number}</p>
            {r.paidAt && <p><span className="text-fg-muted">{t('receipt.paidOn')}:</span> {formatDate(r.paidAt, locale, true)}</p>}
          </div>
        </header>
        <section className="text-sm">
          <p className="text-fg-muted">{t('receipt.customer')}</p>
          <p className="text-lg font-semibold">{r.companyName}</p>
        </section>
        <section className="text-sm">
          <Row k={t('pay.plan')} v={`${r.planName} · ${t(r.period === 'month' ? 'pay.monthly' : 'pay.yearly')}`} />
          <Row k={t('receipt.coverage')} v={`${formatDate(r.periodStart, locale)} – ${formatDate(r.periodEnd, locale)}`} />
          <Row k={t('receipt.subtotal')} v={m(r.subtotal)} />
          <Row k={t('receipt.vat')} v={m(r.vat)} />
          <Row k={t('receipt.total')} v={m(r.total)} strong />
        </section>
        <p className="text-sm text-fg-sub">{t('receipt.method')}</p>
        <p className="rounded-lg bg-subtle p-3 text-xs text-fg-muted">{t('receipt.notTaxInvoice')}</p>
      </article>
    </div>
  );
}
