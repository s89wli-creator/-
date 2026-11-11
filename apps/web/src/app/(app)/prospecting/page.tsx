'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProspectDto, ProspectSearchDto } from '@rakan/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useToast } from '@/components/feedback';
import { AiNotice, useAiStatus } from '@/components/ai/panels';
import { Icon } from '@/components/icons';
import {
  Alert, Badge, Button, Card, CardHeading, EmptyState, ErrorState, Field, Input, LoadingState, Modal, NoPermission, PageHeader, Tabs, Textarea, formatDate,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

type Mode = 'web' | 'text';
type View = 'pending_review' | 'accepted' | 'rejected';

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Prospecting agent: proposes new potential customers from real sources; a person accepts each one. */
export default function ProspectingPage() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useAiStatus();
  const [mode, setMode] = useState<Mode>('web');
  const [view, setView] = useState<View>('pending_review');
  const [rejecting, setRejecting] = useState<ProspectDto | null>(null);
  const prospects = useQuery({ queryKey: ['prospects', view], queryFn: () => api<ProspectDto[]>(`/ai/prospecting/prospects?status=${view}`), enabled: can('ai.use') });
  const searches = useQuery({ queryKey: ['prospect-searches'], queryFn: () => api<ProspectSearchDto[]>('/ai/prospecting/searches'), enabled: can('ai.use') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['prospects'] });
    void qc.invalidateQueries({ queryKey: ['prospect-searches'] });
    void qc.invalidateQueries({ queryKey: ['ai-status'] });
  };
  const run = useMutation({
    mutationFn: (v: { path: string; body: object }) => api<ProspectSearchDto>(v.path, { method: 'POST', body: v.body }),
    onSuccess: (s) => {
      refresh();
      setView('pending_review');
      toast(t('prospect.done', { n: s.found }), s.found ? 'success' : 'info');
    },
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: 'accept' | 'reject'; reason?: string }) =>
      api<ProspectDto>(`/ai/prospecting/prospects/${v.id}/${v.action}`, { method: 'POST', body: v.reason ? { reason: v.reason } : undefined }),
    onSuccess: (p) => {
      setRejecting(null);
      refresh();
      toast(t(p.status === 'accepted' ? 'prospect.accepted' : 'prospect.rejected'));
    },
  });

  if (!can('ai.use')) return <NoPermission />;
  const canCreate = can('crm.account.write');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (mode === 'web') {
      run.mutate({ path: '/ai/prospecting/search', body: { query: String(fd.get('query') ?? ''), city: String(fd.get('city') ?? '') || undefined, limit: Number(fd.get('limit') || 5) } });
    } else {
      run.mutate({ path: '/ai/prospecting/from-text', body: { text: String(fd.get('text') ?? ''), sourceLabel: String(fd.get('sourceLabel') ?? '') } });
    }
  }

  return (
    <>
      <PageHeader title={t('prospect.title')} subtitle={t('prospect.subtitle')} />
      <div className="grid gap-5 lg:grid-cols-[24rem_1fr]">
        <div className="space-y-4">
          <Card className="p-5 sm:p-6">
            <CardHeading>{t('prospect.new')}</CardHeading>
            <AiNotice status={status.data} />
            <div className="mb-4 mt-2 grid grid-cols-2 gap-1 rounded-lg bg-subtle-strong p-1" role="radiogroup" aria-label={t('prospect.new')}>
              {(['web', 'text'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { run.reset(); setMode(m); }}
                  className={`min-h-9 rounded-md text-sm transition-colors ${mode === m ? 'bg-surface font-medium text-fg shadow-xs' : 'text-fg-muted hover:text-fg'}`}>
                  {t(`prospect.mode.${m}` as MessageKey)}
                </button>
              ))}
            </div>
            <form key={mode} onSubmit={submit} className="space-y-4">
              {run.error && <Alert tone="error">{err(run.error)}</Alert>}
              {mode === 'web' ? (
                <>
                  <Field label={t('prospect.query')} htmlFor="query">
                    <Textarea id="query" name="query" rows={3} required minLength={5} maxLength={300} placeholder={t('prospect.queryHint')} />
                  </Field>
                  <div className="grid grid-cols-[1fr_6rem] gap-3">
                    <Field label={t('prospect.city')} htmlFor="city" optional><Input id="city" name="city" maxLength={80} /></Field>
                    <Field label={t('prospect.limit')} htmlFor="limit"><Input id="limit" name="limit" type="number" min={1} max={10} defaultValue={5} dir="ltr" /></Field>
                  </div>
                  <p className="text-xs text-fg-muted">{t('prospect.webNote')}</p>
                </>
              ) : (
                <>
                  <Field label={t('prospect.sourceLabel')} htmlFor="sourceLabel"><Input id="sourceLabel" name="sourceLabel" required minLength={2} maxLength={200} placeholder={t('prospect.sourceLabelHint')} /></Field>
                  <Field label={t('prospect.text')} htmlFor="text"><Textarea id="text" name="text" rows={8} required minLength={20} maxLength={20000} /></Field>
                  <p className="text-xs text-fg-muted">{t('prospect.textNote')}</p>
                </>
              )}
              <Button type="submit" icon="sparkle" className="w-full" loading={run.isPending} disabled={!status.data?.available || !canCreate}>{t('prospect.run')}</Button>
              {!canCreate && <p className="text-xs text-fg-muted">{t('prospect.needWrite')}</p>}
            </form>
          </Card>

          <Card className="p-5">
            <CardHeading>{t('prospect.history')}</CardHeading>
            {searches.data?.length ? (
              <ul className="divide-y divide-line-soft text-sm">
                {searches.data.slice(0, 8).map((s) => (
                  <li key={s.id} className="py-2.5">
                    <p className="line-clamp-2 font-medium">{s.query}</p>
                    <p className="text-xs text-fg-muted">
                      {t(`prospect.mode.${s.source === 'web_search' ? 'web' : 'text'}` as MessageKey)} · {t('prospect.found', { n: s.found })}
                      {s.dropped.length > 0 && ` · ${t('prospect.droppedN', { n: s.dropped.length })}`} · {formatDate(s.createdAt, locale)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-fg-muted">{t('prospect.noHistory')}</p>}
          </Card>
        </div>

        <div className="min-w-0">
          <Tabs<View>
            tabs={(['pending_review', 'accepted', 'rejected'] as const).map((v) => ({ id: v, label: t(`prospect.view.${v}` as MessageKey) }))}
            value={view}
            onChange={setView}
            label={t('prospect.title')}
          />
          {decide.error && <div className="mb-3"><Alert tone="error">{err(decide.error)}</Alert></div>}
          {prospects.isLoading ? <LoadingState card /> : prospects.error ? <ErrorState error={prospects.error} onRetry={() => prospects.refetch()} /> : !prospects.data!.length ? (
            <EmptyState icon="search">{t(view === 'pending_review' ? 'prospect.emptyPending' : 'prospect.empty')}</EmptyState>
          ) : (
            <ul className="stagger space-y-3">
              {prospects.data!.map((p) => (
                <li key={p.id}>
                  <Card className="space-y-3 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-lg font-semibold">{p.name}</h3>
                        <p className="text-sm text-fg-muted">{[p.industry, p.city, p.region].filter(Boolean).join(' · ') || '—'}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {p.duplicateOf && <Badge tone="warn">{t('prospect.duplicate')}</Badge>}
                        <Badge tone="muted">{t('ai.confidence')} {Math.round(p.confidence * 100)}%</Badge>
                      </div>
                    </div>
                    <p className="text-fg-sub">{p.whyFit}</p>
                    {p.fitEvidence.length > 0 && (
                      <div className="flex flex-wrap gap-1">{p.fitEvidence.map((e) => <span key={e.ref} className="rounded-md bg-subtle px-1.5 py-0.5 text-xs text-fg-muted" title={e.text}>{e.label}</span>)}</div>
                    )}
                    <dl className="grid gap-2 border-t border-line-soft pt-3 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-xs text-fg-muted">{t('prospect.source')}</dt>
                        <dd className="truncate">
                          {p.sourceUrl.startsWith('manual:') ? (p.sourceTitle ?? t('prospect.mode.text')) : (
                            <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-brand-700 hover:underline" dir="ltr">{hostOf(p.sourceUrl)}</a>
                          )}
                        </dd>
                      </div>
                      <div><dt className="text-xs text-fg-muted">{t('prospect.website')}</dt><dd dir="ltr" className="text-start">{p.websiteDomain ?? '—'}</dd></div>
                      <div><dt className="text-xs text-fg-muted">{t('prospect.retrieved')}</dt><dd>{formatDate(p.retrievedAt, locale)}</dd></div>
                    </dl>
                    {p.duplicateOf && (
                      <Alert tone="warn">{t('prospect.duplicateHint')} <Link href={`/accounts/${p.duplicateOf.id}`} className="font-medium underline">{p.duplicateOf.name}</Link></Alert>
                    )}
                    {p.status === 'pending_review' && canCreate && (
                      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-3 sm:flex-row sm:justify-end">
                        <Button variant="danger" onClick={() => { decide.reset(); setRejecting(p); }}>{t('prospect.reject')}</Button>
                        <Button icon="plus" disabled={!!p.duplicateOf} loading={decide.isPending && decide.variables?.id === p.id && decide.variables.action === 'accept'} onClick={() => decide.mutate({ id: p.id, action: 'accept' })}>
                          {t('prospect.accept')}
                        </Button>
                      </div>
                    )}
                    {p.status === 'accepted' && p.accountId && (
                      <Link href={`/accounts/${p.accountId}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">{t('prospect.openAccount')} <Icon name="chevronEnd" size={16} /></Link>
                    )}
                    {p.status === 'rejected' && <p className="text-sm text-fg-muted">{t('prospect.rejectedBecause', { reason: p.rejectReason ?? '—' })}</p>}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title={t('prospect.reject')}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); decide.mutate({ id: rejecting!.id, action: 'reject', reason: String(new FormData(e.currentTarget).get('reason') ?? '') }); }}>
          {decide.error && <Alert tone="error">{err(decide.error)}</Alert>}
          <Field label={t('prospect.rejectReason')} htmlFor="reason"><Input id="reason" name="reason" required minLength={2} maxLength={300} /></Field>
          <Button type="submit" variant="danger-solid" className="w-full" loading={decide.isPending}>{t('prospect.reject')}</Button>
        </form>
      </Modal>
    </>
  );
}
