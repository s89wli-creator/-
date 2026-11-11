'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VAT_RATE, type ContactDto, type OpportunityDto, type PriceListItemDto, type ProposalDto, type ProposalWarning } from '@rakan/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useMemo, useState } from 'react';
import { useConfirm, useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { STATUS_TONE, money } from '@/components/proposals/ProposalDocument';
import {
  Alert, BackLink, Badge, Button, ButtonLink, Card, CardHeading, ErrorState, Field, IconButton, Input, LoadingState, NoPermission, Select, Textarea, formatDate,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

interface Line {
  key: string; brainItemId?: string; name: string; description: string; unit: string; quantity: number; unitPrice: number; discountPct: number; manual: boolean;
}
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
let seq = 0;
const lineKey = () => `l${++seq}`;

function toLines(p: ProposalDto): Line[] {
  return p.items.map((i) => ({
    key: lineKey(), brainItemId: i.brainItemId ?? undefined, name: i.name, description: i.description ?? '', unit: i.unit ?? '', quantity: i.quantity,
    unitPrice: i.unitPrice, discountPct: i.discountPct, manual: i.priceSource === 'manual',
  }));
}

function warningText(t: (k: MessageKey, v?: Record<string, string | number>) => string, w: ProposalWarning, locale: 'ar' | 'en'): string {
  const v: Record<string, string | number> = {};
  if ('item' in w) v.item = w.item;
  if ('limit' in w) v.limit = w.limit;
  if ('listPrice' in w) v.price = money(w.listPrice, 'SAR', locale);
  return t(`proposal.warn.${w.code}` as MessageKey, v);
}

function Editor({ id }: { id: string }) {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const params = useSearchParams();
  const unmatched = useMemo<string[]>(() => {
    try {
      return JSON.parse(params.get('unmatched') ?? '[]') as string[];
    } catch {
      return [];
    }
  }, [params]);
  const q = useQuery({ queryKey: ['proposal', id], queryFn: () => api<ProposalDto>(`/crm/proposals/${id}`) });
  const p = q.data;
  const editable = !!p && p.status === 'draft' && can('crm.proposal.write');
  const prices = useQuery({ queryKey: ['price-list'], queryFn: () => api<PriceListItemDto[]>('/crm/proposals/price-list'), enabled: editable });
  const contacts = useQuery({ queryKey: ['contacts', p?.account.id], queryFn: () => api<ContactDto[]>(`/crm/accounts/${p!.account.id}/contacts`), enabled: editable });
  const opps = useQuery({ queryKey: ['opps', p?.account.id], queryFn: () => api<OpportunityDto[]>(`/crm/opportunities?accountId=${p!.account.id}`), enabled: editable });

  const [lines, setLines] = useState<Line[]>([]);
  const [form, setForm] = useState({ title: '', intro: '', terms: '', validUntil: '', contactId: '', opportunityId: '' });
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!p) return;
    setLines(toLines(p));
    setForm({ title: p.title, intro: p.intro, terms: p.terms, validUntil: p.validUntil, contactId: p.contact?.id ?? '', opportunityId: p.opportunity?.id ?? '' });
    setDirty(false);
  }, [p]);

  const done = (d: ProposalDto, msg?: string) => {
    qc.setQueryData(['proposal', id], d);
    void qc.invalidateQueries({ queryKey: ['proposals'] });
    if (msg) toast(msg);
  };
  const save = useMutation({
    mutationFn: () => api<ProposalDto>(`/crm/proposals/${id}`, {
      method: 'PATCH',
      body: {
        title: form.title, intro: form.intro, terms: form.terms, validUntil: form.validUntil, contactId: form.contactId || null, opportunityId: form.opportunityId || null,
        items: lines.map((l) => (l.manual
          ? { name: l.name, description: l.description || undefined, unit: l.unit || undefined, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct }
          : { brainItemId: l.brainItemId, description: l.description || undefined, quantity: l.quantity, discountPct: l.discountPct })),
      },
    }),
    onSuccess: (d) => done(d, t('proposal.saved')),
  });
  const action = useMutation({
    mutationFn: (a: 'submit' | 'cancel' | 'revise') => api<ProposalDto>(`/crm/proposals/${id}/${a}`, { method: 'POST' }),
    onSuccess: (d, a) => {
      done(d, a === 'submit' ? t('proposal.submitted') : undefined);
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  if (!can('crm.proposal.read')) return <NoPermission />;
  if (q.isLoading) return <LoadingState card />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!p) return null;

  const totals = (() => {
    const rows = lines.map((l) => {
      const gross = r2(l.quantity * l.unitPrice);
      return { gross, net: r2(gross * (1 - l.discountPct / 100)) };
    });
    const subtotal = r2(rows.reduce((a, r) => a + r.net, 0));
    const discount = r2(rows.reduce((a, r) => a + (r.gross - r.net), 0));
    const vat = r2((subtotal * VAT_RATE) / 100);
    return { rows, subtotal, discount, vat, total: r2(subtotal + vat) };
  })();
  const shown = editable ? totals : { subtotal: p.subtotal, discount: p.discountTotal, vat: p.vatAmount, total: p.total };
  const m = (n: number) => money(n, p.currency, locale);
  const set = (patch: Partial<typeof form>) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };
  const setLine = (key: string, patch: Partial<Line>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setDirty(true); };

  const busy = save.isPending || action.isPending;
  const whatsapp = p.shareUrl ? `https://wa.me/?text=${encodeURIComponent(`${p.title} — ${p.number}\n${p.shareUrl}`)}` : null;

  return (
    <div className="space-y-5">
      <BackLink href="/proposals">{t('proposal.title')}</BackLink>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold">{p.title}</h1>
            <Badge tone={STATUS_TONE[p.status]} dot>{t(`proposal.status.${p.status}`)}</Badge>
            {p.expired && <Badge tone="warn">{t('proposal.expired')}</Badge>}
            {p.source === 'agent' && <Badge tone="accent">{t('proposal.byAgent')}</Badge>}
          </div>
          <p className="text-sm text-fg-muted">
            <span dir="ltr">{p.number}</span> · {t('proposal.version', { n: p.version })} · <Link href={`/accounts/${p.account.id}`} className="text-brand-700 hover:underline">{p.account.name}</Link>
            {p.ownerName ? ` · ${p.ownerName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/print/proposals/${p.id}`} icon="printer">{t('proposal.print')}</ButtonLink>
          {p.status === 'pending_approval' && p.approvalRequestId && can('approvals.decide') && <ButtonLink href="/approvals" icon="checkCircle">{t('proposal.openApproval')}</ButtonLink>}
          {can('crm.proposal.write') && ['declined', 'sent'].includes(p.status) && (
            <Button variant="secondary" disabled={busy} onClick={async () => { if (await confirm({ title: t('proposal.revise'), body: t('proposal.reviseConfirm'), tone: 'default' })) action.mutate('revise'); }}>{t('proposal.revise')}</Button>
          )}
          {can('crm.proposal.write') && ['draft', 'sent'].includes(p.status) && (
            <Button variant="danger" disabled={busy} onClick={async () => { if (await confirm({ title: t('proposal.cancel'), body: t('proposal.cancelConfirm') })) action.mutate('cancel'); }}>{t('proposal.cancel')}</Button>
          )}
        </div>
      </div>

      {(save.error || action.error) && <Alert tone="error">{err(save.error ?? action.error)}</Alert>}
      {unmatched.length > 0 && p.status === 'draft' && (
        <Alert tone="info"><span className="font-medium">{t('proposal.unmatched')}</span> {unmatched.join('، ')}</Alert>
      )}
      {p.warnings.length > 0 && (
        <Alert tone="warn">
          <span className="font-medium">{t('proposal.warnings')}</span>
          <ul className="mt-1 list-disc ps-5">{p.warnings.map((w, i) => <li key={i}>{warningText(t, w, locale)}</li>)}</ul>
        </Alert>
      )}

      {p.shareUrl && (
        <Card className="space-y-3 p-5">
          <CardHeading>{t('proposal.share')}</CardHeading>
          <p className="text-sm text-fg-muted">{t('proposal.shareHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly value={p.shareUrl} dir="ltr" className="min-w-0 flex-1" aria-label={t('proposal.share')} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" icon="copy" onClick={() => void navigator.clipboard.writeText(p.shareUrl!).then(() => toast(t('proposal.copied')))}>{t('proposal.copy')}</Button>
            {whatsapp && <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-4 text-sm font-medium hover:border-brand-600">{t('proposal.whatsapp')}</a>}
          </div>
          <p className="text-xs text-fg-muted">
            {p.sentAt && `${t('proposal.status.sent')}: ${formatDate(p.sentAt, locale, true)}`}
            {p.viewedAt && ` · ${t('proposal.viewed')}: ${formatDate(p.viewedAt, locale, true)}`}
          </p>
          {p.decidedAt && (
            <Alert tone={p.status === 'accepted' ? 'success' : 'info'}>
              {t('proposal.decision', { name: p.decisionByName ?? '—' })} — {t(`proposal.status.${p.status}`)} · {formatDate(p.decidedAt, locale, true)}
              {p.decisionNote && <span className="block">“{p.decisionNote}”</span>}
            </Alert>
          )}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-5">
          <Card className="p-5 sm:p-6">
            <CardHeading>{t('proposal.items')}</CardHeading>
            {editable && prices.data && !prices.data.length && <div className="mb-3"><Alert tone="warn">{t('proposal.noPriceList')}</Alert></div>}
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-xs text-fg-muted">
                  <tr>
                    <th className="px-2 py-2 text-start font-medium">{t('proposal.item')}</th>
                    <th className="w-24 px-2 text-end font-medium">{t('proposal.qty')}</th>
                    <th className="w-32 px-2 text-end font-medium">{t('proposal.unitPrice')}</th>
                    <th className="w-24 px-2 text-end font-medium">{t('proposal.discount')}</th>
                    <th className="w-32 px-2 text-end font-medium">{t('proposal.lineTotal')}</th>
                    {editable && <th className="w-10" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {editable ? lines.map((l, n) => (
                    <tr key={l.key} className="align-top">
                      <td className="space-y-1 px-2 py-2">
                        {l.manual ? (
                          <Input aria-label={t('proposal.item')} value={l.name} maxLength={200} onChange={(e) => setLine(l.key, { name: e.target.value })} />
                        ) : <p className="pt-2 font-medium">{l.name}</p>}
                        <Input aria-label={t('proposal.description')} placeholder={t('proposal.description')} value={l.description} maxLength={1000} className="min-h-9 text-xs" onChange={(e) => setLine(l.key, { description: e.target.value })} />
                        <Badge tone={l.manual ? 'warn' : 'muted'}>{l.manual ? t('proposal.manualPrice') : t('proposal.fromList')}</Badge>
                      </td>
                      <td className="px-2 py-2"><Input type="number" min={0.01} step="any" dir="ltr" aria-label={t('proposal.qty')} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: Number(e.target.value) })} /></td>
                      <td className="px-2 py-2">
                        {l.manual
                          ? <Input type="number" min={0} step="0.01" dir="ltr" aria-label={t('proposal.unitPrice')} value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: Number(e.target.value) })} />
                          : <p className="pt-2 text-end tabular-nums">{m(l.unitPrice)}</p>}
                      </td>
                      <td className="px-2 py-2"><Input type="number" min={0} max={100} step="0.5" dir="ltr" aria-label={t('proposal.discount')} value={l.discountPct} onChange={(e) => setLine(l.key, { discountPct: Number(e.target.value) })} /></td>
                      <td className="px-2 py-2 pt-4 text-end font-medium tabular-nums">{m(totals.rows[n]?.net ?? 0)}</td>
                      <td className="py-2"><IconButton icon="trash" label={t('proposal.removeLine')} onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setDirty(true); }} /></td>
                    </tr>
                  )) : p.items.map((i) => (
                    <tr key={i.id}>
                      <td className="px-2 py-2.5">
                        <p className="font-medium">{i.name}</p>
                        {i.description && <p className="text-xs text-fg-muted">{i.description}</p>}
                        {i.priceSource === 'manual' && <Badge tone="warn">{t('proposal.manualPrice')}</Badge>}
                      </td>
                      <td className="px-2 text-end tabular-nums">{i.quantity}{i.unit ? ` ${i.unit}` : ''}</td>
                      <td className="px-2 text-end tabular-nums">{m(i.unitPrice)}</td>
                      <td className="px-2 text-end tabular-nums">{i.discountPct ? `${i.discountPct}%` : '—'}</td>
                      <td className="px-2 text-end font-medium tabular-nums">{m(i.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {editable && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
                <label htmlFor="add-price" className="sr-only">{t('proposal.addFromList')}</label>
                <Select id="add-price" value="" className="max-w-xs" disabled={!prices.data?.length}
                  onChange={(e) => {
                    const pr = prices.data?.find((x) => x.id === e.target.value);
                    if (!pr) return;
                    setLines((ls) => [...ls, { key: lineKey(), brainItemId: pr.id, name: pr.product, description: '', unit: pr.unit ?? '', quantity: 1, unitPrice: pr.price, discountPct: 0, manual: false }]);
                    setDirty(true);
                  }}>
                  <option value="">+ {t('proposal.addFromList')}</option>
                  {prices.data?.map((x) => <option key={x.id} value={x.id}>{x.product} — {money(x.price, x.currency, locale)}{x.unit ? ` / ${x.unit}` : ''}</option>)}
                </Select>
                <Button variant="ghost" icon="plus" onClick={() => { setLines((ls) => [...ls, { key: lineKey(), name: '', description: '', unit: '', quantity: 1, unitPrice: 0, discountPct: 0, manual: true }]); setDirty(true); }}>
                  {t('proposal.addManual')}
                </Button>
              </div>
            )}
          </Card>

          <Card className="space-y-4 p-5 sm:p-6">
            {editable ? (
              <>
                <Field label={t('proposal.name')} htmlFor="p-title"><Input id="p-title" value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} /></Field>
                <Field label={t('proposal.intro')} htmlFor="p-intro"><Textarea id="p-intro" rows={4} maxLength={5000} value={form.intro} onChange={(e) => set({ intro: e.target.value })} /></Field>
                <Field label={t('proposal.terms')} htmlFor="p-terms" hint={t('proposal.termsHint')}><Textarea id="p-terms" rows={6} maxLength={10000} value={form.terms} onChange={(e) => set({ terms: e.target.value })} /></Field>
              </>
            ) : (
              <>
                {p.intro && <div><h2 className="mb-1 font-semibold">{t('proposal.intro')}</h2><p className="whitespace-pre-wrap text-fg-sub">{p.intro}</p></div>}
                {p.terms && <div><h2 className="mb-1 font-semibold">{t('proposal.terms')}</h2><p className="whitespace-pre-wrap text-sm text-fg-sub">{p.terms}</p></div>}
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="space-y-2 p-5 text-sm">
            {shown.discount > 0 && <div className="flex justify-between"><span className="text-fg-muted">{t('proposal.discountTotal')}</span><span className="tabular-nums">− {m(shown.discount)}</span></div>}
            <div className="flex justify-between"><span className="text-fg-muted">{t('proposal.subtotal')}</span><span className="tabular-nums">{m(shown.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-fg-muted">{t('proposal.vat', { rate: p.vatRate })}</span><span className="tabular-nums">{m(shown.vat)}</span></div>
            <div className="flex justify-between border-t border-line pt-2 text-lg font-bold"><span>{t('proposal.total')}</span><span className="tabular-nums">{m(shown.total)}</span></div>
          </Card>

          <Card className="space-y-4 p-5">
            {editable ? (
              <>
                <Field label={t('proposal.contact')} htmlFor="p-contact">
                  <Select id="p-contact" value={form.contactId} onChange={(e) => set({ contactId: e.target.value })}>
                    <option value="">{t('proposal.noContact')}</option>
                    {contacts.data?.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
                  </Select>
                </Field>
                <Field label={t('proposal.opportunity')} htmlFor="p-opp">
                  <Select id="p-opp" value={form.opportunityId} onChange={(e) => set({ opportunityId: e.target.value })}>
                    <option value="">{t('proposal.none')}</option>
                    {opps.data?.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                  </Select>
                </Field>
                <Field label={t('proposal.validUntil')} htmlFor="p-valid"><Input id="p-valid" type="date" dir="ltr" value={form.validUntil} onChange={(e) => set({ validUntil: e.target.value })} /></Field>
                <div className="flex flex-col gap-2">
                  <Button variant="secondary" loading={save.isPending} disabled={!dirty || busy} onClick={() => save.mutate()}>{t('proposal.save')}</Button>
                  <Button icon="checkCircle" loading={action.isPending && action.variables === 'submit'} disabled={dirty || busy || !p.items.length} onClick={() => action.mutate('submit')}>{t('proposal.submit')}</Button>
                </div>
              </>
            ) : (
              <dl className="space-y-2 text-sm">
                <div><dt className="text-xs text-fg-muted">{t('proposal.contact')}</dt><dd>{p.contact?.name ?? t('proposal.noContact')}</dd></div>
                <div><dt className="text-xs text-fg-muted">{t('proposal.opportunity')}</dt><dd>{p.opportunity ? <Link href={`/pipeline`} className="text-brand-700 hover:underline">{p.opportunity.name}</Link> : '—'}</dd></div>
                <div><dt className="text-xs text-fg-muted">{t('proposal.validUntil')}</dt><dd>{formatDate(`${p.validUntil}T12:00:00Z`, locale)}</dd></div>
              </dl>
            )}
          </Card>
          {p.agentRunId && <p className="flex items-center gap-1 text-xs text-fg-muted"><Icon name="sparkle" size={16} /> {t('proposal.byAgent')}</p>}
        </div>
      </div>
    </div>
  );
}

export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={<LoadingState card />}><Editor id={id} /></Suspense>;
}
