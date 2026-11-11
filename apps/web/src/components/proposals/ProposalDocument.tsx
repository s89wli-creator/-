'use client';

import type { ProposalStatusKey, PublicProposalDto } from '@rakan/shared';
import { useI18n } from '@/lib/providers';
import { formatDate } from '@/components/ui';

export type ProposalDoc = Omit<PublicProposalDto, 'status' | 'decidedAt' | 'decisionByName' | 'expired'> & { contactName?: string | null };

export const money = (n: number, currency = 'SAR', locale: 'ar' | 'en' = 'ar') =>
  `${new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${locale === 'ar' && currency === 'SAR' ? 'ر.س' : currency}`;

export const STATUS_TONE: Record<ProposalStatusKey, 'muted' | 'accent' | 'brand' | 'success' | 'danger'> = {
  draft: 'muted', pending_approval: 'accent', sent: 'brand', accepted: 'success', declined: 'danger', cancelled: 'muted',
};

/** The proposal as the customer sees it: used for printing (PDF) and the customer link. */
export function ProposalDocument({ doc }: { doc: ProposalDoc }) {
  const { t, locale } = useI18n();
  const m = (n: number) => money(n, doc.currency, locale);
  return (
    <article className="proposal-doc mx-auto max-w-3xl space-y-6 bg-surface p-6 text-fg sm:p-10 print:max-w-none print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-petrol pb-5">
        <div>
          <p className="font-display text-2xl font-bold text-petrol">{doc.companyName}</p>
          {doc.preparedBy && <p className="text-sm text-fg-muted">{t('proposal.preparedBy', { name: doc.preparedBy })}</p>}
        </div>
        <div className="text-end text-sm">
          <p className="font-display text-xl font-semibold">{t('public.title')}</p>
          <p><span className="text-fg-muted">{t('proposal.number')}:</span> <span dir="ltr">{doc.number}</span></p>
          {doc.sentAt && <p><span className="text-fg-muted">{t('proposal.date')}:</span> {formatDate(doc.sentAt, locale)}</p>}
          <p><span className="text-fg-muted">{t('proposal.validUntil')}:</span> {formatDate(`${doc.validUntil}T12:00:00Z`, locale)}</p>
        </div>
      </header>

      <section>
        <p className="text-sm text-fg-muted">{t('proposal.to')}</p>
        <p className="text-lg font-semibold">{doc.customerName}{doc.contactName ? ` — ${doc.contactName}` : ''}</p>
        <h1 className="mt-3 font-display text-xl font-semibold">{doc.title}</h1>
        {doc.intro && <p className="mt-2 whitespace-pre-wrap leading-relaxed text-fg-sub">{doc.intro}</p>}
      </section>

      {/* Phones: one block per line, no sideways scrolling. */}
      <ul className="divide-y divide-line-soft border-y border-line-soft sm:hidden print:hidden">
        {doc.items.map((i, n) => (
          <li key={n} className="space-y-1 py-3 text-sm">
            <div className="flex justify-between gap-3">
              <p className="font-medium">{n + 1}. {i.name}</p>
              <p className="shrink-0 font-semibold tabular-nums">{m(i.lineTotal)}</p>
            </div>
            {i.description && <p className="text-xs text-fg-muted">{i.description}</p>}
            <p className="text-xs text-fg-muted tabular-nums">
              {i.quantity}{i.unit ? ` ${i.unit}` : ''} × {m(i.unitPrice)}{i.discountPct ? ` · −${i.discountPct}%` : ''}
            </p>
          </li>
        ))}
      </ul>

      <section className="hidden overflow-x-auto sm:block print:block">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr className="bg-petrol text-white print:bg-petrol">
              <th className="px-3 py-2 text-start font-medium">#</th>
              <th className="px-3 py-2 text-start font-medium">{t('proposal.item')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('proposal.qty')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('proposal.unitPrice')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('proposal.discount')}</th>
              <th className="px-3 py-2 text-end font-medium">{t('proposal.lineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((i, n) => (
              <tr key={n} className="border-b border-line-soft align-top">
                <td className="px-3 py-2.5 tabular-nums">{n + 1}</td>
                <td className="px-3 py-2.5">
                  <p className="font-medium">{i.name}</p>
                  {i.description && <p className="text-xs text-fg-muted">{i.description}</p>}
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums">{i.quantity}{i.unit ? ` ${i.unit}` : ''}</td>
                <td className="px-3 py-2.5 text-end tabular-nums">{m(i.unitPrice)}</td>
                <td className="px-3 py-2.5 text-end tabular-nums">{i.discountPct ? `${i.discountPct}%` : '—'}</td>
                <td className="px-3 py-2.5 text-end font-medium tabular-nums">{m(i.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ms-auto w-full max-w-xs space-y-1.5 text-sm">
        {doc.discountTotal > 0 && <Row label={t('proposal.discountTotal')} value={`− ${m(doc.discountTotal)}`} />}
        <Row label={t('proposal.subtotal')} value={m(doc.subtotal)} />
        <Row label={t('proposal.vat', { rate: doc.vatRate })} value={m(doc.vatAmount)} />
        <div className="flex justify-between border-t-2 border-petrol pt-2 text-base font-bold">
          <span>{t('proposal.total')}</span><span className="tabular-nums">{m(doc.total)}</span>
        </div>
      </section>

      {doc.terms && (
        <section className="border-t border-line pt-4">
          <h2 className="mb-1 font-semibold">{t('proposal.terms')}</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-sub">{doc.terms}</p>
        </section>
      )}
      <p className="text-xs text-fg-muted">{t('proposal.pricesNote')}</p>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span className="text-fg-muted">{label}</span><span className="tabular-nums">{value}</span></div>;
}
