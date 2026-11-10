'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContactDto, Evidence, LeadScoreDto, MeetingInsightsDto, MessageDraftDto, VisitBriefDto } from '@rakan/shared';
import { useState, type ReactNode } from 'react';
import { useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LoadingState, Modal, Select, Textarea, cx, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

interface AiStatus { available: boolean; providerReady: boolean; enabled: boolean; budgetReached: boolean; agents: Record<string, { enabled: boolean }> }

export function useAiStatus() {
  const can = useCan();
  return useQuery({ queryKey: ['ai-status'], queryFn: () => api<AiStatus>('/ai/status'), enabled: can('ai.use'), staleTime: 60_000 });
}

/** Explains honestly why the assistant can't run (never a fake result). */
export function AiNotice({ status }: { status: AiStatus | undefined }) {
  const { t } = useI18n();
  if (!status || status.available) return null;
  const key: MessageKey = !status.providerReady ? 'ai.notice.notConfigured' : !status.enabled ? 'ai.notice.disabled' : 'ai.notice.budget';
  return <Alert tone="info">{t(key)}</Alert>;
}

/** Header strip used by every assistant card: sparkle icon, title, and an "AI-generated, review it" hint. */
function AiCard({ title, action, children, hint = true }: { title: string; action?: ReactNode; children: ReactNode; hint?: boolean }) {
  const { t } = useI18n();
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-700" aria-hidden><Icon name="sparkle" size={20} /></span>
          <div>
            <h3 className="font-semibold">{title}</h3>
            {hint && <p className="text-xs text-fg-muted">{t('ai.reviewHint')}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function EvidenceChips({ items }: { items: Evidence[] }) {
  if (!items.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {items.map((e) => (
        <span key={e.ref} className="rounded-md bg-subtle px-1.5 py-0.5 text-xs text-fg-muted" title={e.ref}>{e.label}</span>
      ))}
    </span>
  );
}

function Removed({ items }: { items: { text: string; reason: string }[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="mt-4 border-t border-line-soft pt-3 text-sm">
      <button className="text-fg-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('ai.removed', { n: items.length })} {open ? '▴' : '▾'}
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {items.map((r, i) => (
            <li key={i} className="text-fg-muted">
              <Badge tone="muted">{t(`ai.removed.${r.reason}` as MessageKey)}</Badge> <span className="line-through decoration-fg-muted/40">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

// ================================================================ lead score

const TIER_TONE = { A: 'success', B: 'brand', C: 'warn', D: 'muted' } as const;

export function LeadScorePanel({ accountId, canWrite }: { accountId: string; canWrite: boolean }) {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const invalidate = useInvalidate();
  const status = useAiStatus();
  const scores = useQuery({ queryKey: ['ai-scores', accountId], queryFn: () => api<LeadScoreDto[]>(`/ai/accounts/${accountId}/scores`) });
  const run = useMutation({
    mutationFn: () => api<LeadScoreDto>(`/ai/accounts/${accountId}/score`, { method: 'POST' }),
    onSuccess: () => {
      toast(t('ai.score.done'));
      invalidate('ai-scores');
      invalidate('account');
      invalidate('ai-status');
    },
  });
  const [override, setOverride] = useState(false);
  const review = useMutation({
    mutationFn: (body: object) => api(`/ai/scores/${scores.data![0]!.id}/review`, { method: 'POST', body }),
    onSuccess: () => {
      setOverride(false);
      toast(t('common.saveSuccess'));
      invalidate('ai-scores');
      invalidate('account');
    },
  });
  const s = scores.data?.[0];
  const tier = (s?.overrideTier ?? s?.tier) as keyof typeof TIER_TONE | undefined;

  return (
    <AiCard
      title={t('ai.score.title')}
      action={canWrite && (
        <Button variant={s ? 'secondary' : 'primary'} icon="sparkle" loading={run.isPending} disabled={!status.data?.available} onClick={() => run.mutate()}>
          {t(s ? 'ai.score.rerun' : 'ai.score.run')}
        </Button>
      )}
    >
      <AiNotice status={status.data} />
      {run.error && <Alert tone="error">{err(run.error)}</Alert>}
      {scores.isLoading ? <LoadingState rows={3} /> : !s ? (
        <p className="text-sm text-fg-muted">{t('ai.score.empty')}</p>
      ) : (
        <div className="animate-fade-up space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid size-16 place-items-center rounded-2xl bg-subtle text-center">
              <span className="text-2xl font-bold">{tier}</span>
            </div>
            <div className="space-y-1 text-sm">
              <p><strong className="text-lg">{s.score}</strong><span className="text-fg-muted">/100</span> · {t('ai.confidence')}: {pct(s.confidence)}</p>
              <div className="flex flex-wrap gap-1.5">
                {s.disqualified && <Badge tone="danger">{t('ai.score.disqualified')}</Badge>}
                {s.reviewStatus === 'overridden' && <Badge tone="warn">{t('ai.score.overridden', { tier: s.tier })}</Badge>}
                {s.reviewStatus === 'accepted' && <Badge tone="success">{t('ai.score.accepted')}</Badge>}
                <Badge tone={TIER_TONE[tier!]}>{t('ai.score.tier', { tier: tier! })}</Badge>
              </div>
              <p className="text-xs text-fg-muted">{formatDate(s.createdAt, locale, true)}</p>
            </div>
          </div>
          {s.summary && <p className="whitespace-pre-wrap text-fg-sub">{s.summary}</p>}
          <ul className="space-y-3">
            {s.criteria.map((c) => (
              <li key={c.key} className="text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{t(`ai.criterion.${c.key}` as MessageKey)} <span className="text-xs text-fg-muted">({c.weight}%)</span></span>
                  <span className="tabular-nums text-fg-sub">{c.score}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle-strong" aria-hidden>
                  <div className="h-full origin-right ltr:origin-left rounded-full bg-brand-600 transition-transform duration-300" style={{ transform: `scaleX(${c.score / 100})` }} />
                </div>
                <p className="mt-1 text-fg-muted">{c.reason}{c.method === 'rule' && <> · <Badge tone="muted">{t('ai.byRule')}</Badge></>}</p>
                <EvidenceChips items={c.evidence} />
              </li>
            ))}
          </ul>
          {s.missingData.length > 0 && (
            <div className="rounded-lg bg-warn-soft p-3 text-sm">
              <p className="font-medium text-warn">{t('ai.missingData')}</p>
              <p className="text-fg-sub">{s.missingData.join('، ')}</p>
            </div>
          )}
          {canWrite && s.reviewStatus === 'unreviewed' && (
            <div className="flex flex-wrap gap-2 border-t border-line-soft pt-4">
              <Button variant="secondary" icon="check" loading={review.isPending && !override} onClick={() => review.mutate({ decision: 'accept' })}>{t('ai.score.accept')}</Button>
              <Button variant="ghost" onClick={() => setOverride(true)}>{t('ai.score.override')}</Button>
            </div>
          )}
        </div>
      )}
      <Modal open={override} onClose={() => setOverride(false)} title={t('ai.score.override')}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            review.mutate({ decision: 'override', tier: fd.get('tier'), note: String(fd.get('note') ?? '') || undefined });
          }}
        >
          {review.error && <Alert tone="error">{err(review.error)}</Alert>}
          <Field label={t('ai.score.newTier')} htmlFor="ov-tier">
            <Select id="ov-tier" name="tier" defaultValue={s?.tier}>{['A', 'B', 'C', 'D'].map((x) => <option key={x}>{x}</option>)}</Select>
          </Field>
          <Field label={t('ai.score.reason')} htmlFor="ov-note" optional>
            <Textarea id="ov-note" name="note" rows={3} maxLength={500} />
          </Field>
          <Button type="submit" className="w-full" loading={review.isPending}>{t('common.save')}</Button>
        </form>
      </Modal>
    </AiCard>
  );
}

// ================================================================ follow-up drafts

const DRAFT_TONE: Record<string, 'neutral' | 'warn' | 'success' | 'danger' | 'brand' | 'muted' | 'accent'> = {
  draft: 'neutral', pending_approval: 'accent', approved: 'brand', sent: 'success', rejected: 'danger', cancelled: 'muted',
};

export function FollowUpPanel({ accountId, contacts, canWrite }: { accountId: string; contacts: ContactDto[]; canWrite: boolean }) {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const invalidate = useInvalidate();
  const status = useAiStatus();
  const drafts = useQuery({ queryKey: ['ai-drafts', accountId], queryFn: () => api<MessageDraftDto[]>(`/ai/accounts/${accountId}/drafts`) });
  const reachable = contacts.filter((c) => !c.doNotContact);
  const [contactId, setContactId] = useState('');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email');
  const [editing, setEditing] = useState<MessageDraftDto | null>(null);
  const gen = useMutation({
    mutationFn: () => api<MessageDraftDto>(`/ai/accounts/${accountId}/follow-up`, { method: 'POST', body: { contactId: contactId || reachable[0]?.id, channel } }),
    onSuccess: (d) => {
      invalidate('ai-drafts');
      invalidate('ai-status');
      setEditing(d);
    },
  });
  const save = useMutation({
    mutationFn: (v: { id: string; subject: string | null; body: string }) => api<MessageDraftDto>(`/ai/drafts/${v.id}`, { method: 'PATCH', body: { subject: v.subject, body: v.body } }),
    onSuccess: (d) => {
      setEditing(d);
      invalidate('ai-drafts');
      toast(t('common.saveSuccess'));
    },
  });
  const submit = useMutation({
    mutationFn: (id: string) => api<MessageDraftDto>(`/ai/drafts/${id}/submit`, { method: 'POST' }),
    onSuccess: () => {
      setEditing(null);
      invalidate('ai-drafts');
      toast(t('ai.draft.submitted'));
    },
  });

  return (
    <AiCard title={t('ai.draft.title')}>
      <AiNotice status={status.data} />
      {gen.error && <Alert tone="error">{err(gen.error)}</Alert>}
      {canWrite && (
        reachable.length ? (
          <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <Field label={t('ai.draft.to')} htmlFor="fu-contact">
              <Select id="fu-contact" value={contactId || reachable[0]!.id} onChange={(e) => setContactId(e.target.value)}>
                {reachable.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.jobTitle ? ` — ${c.jobTitle}` : ''}</option>)}
              </Select>
            </Field>
            <Field label={t('ai.draft.channel')} htmlFor="fu-channel">
              <Select id="fu-channel" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'whatsapp')}>
                <option value="email">{t('ai.channel.email')}</option>
                <option value="whatsapp">{t('ai.channel.whatsapp')}</option>
              </Select>
            </Field>
            <Button icon="sparkle" loading={gen.isPending} disabled={!status.data?.available} onClick={() => gen.mutate()}>{t('ai.draft.generate')}</Button>
          </div>
        ) : (
          <p className="mb-4 text-sm text-fg-muted">{t('ai.draft.noContacts')}</p>
        )
      )}
      {drafts.isLoading ? <LoadingState rows={2} /> : drafts.data?.length ? (
        <ul className="divide-y divide-line-soft">
          {drafts.data.map((d) => (
            <li key={d.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {d.subject ?? t(`ai.channel.${d.channel}` as MessageKey)} <span className="text-fg-muted">→ {d.contactName}</span>
                </p>
                <Badge tone={DRAFT_TONE[d.status]} dot>{t(`ai.draft.status.${d.status}` as MessageKey)}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{d.body}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span>{formatDate(d.createdAt, locale, true)}</span>
                {canWrite && ['draft', 'rejected'].includes(d.status) && <Button variant="ghost" className="min-h-9" onClick={() => setEditing(d)}>{t('common.edit')}</Button>}
                {d.sendLink && (
                  <a href={d.sendLink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-on-brand">
                    {t('ai.draft.openWhatsapp')}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="inbox">{t('ai.draft.empty')}</EmptyState>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={t('ai.draft.review')} size="lg">
        {editing && (
          <form
            key={editing.id + editing.body}
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              save.mutate({ id: editing.id, subject: editing.channel === 'email' ? String(fd.get('subject') ?? '') : null, body: String(fd.get('body') ?? '') });
            }}
          >
            <Alert tone="info">{t('ai.draft.approvalNote')}</Alert>
            {editing.forbiddenHits.length > 0 && (
              <Alert tone="warn">
                <p className="font-medium">{t('ai.draft.flagged')}</p>
                <ul className="mt-1 list-inside list-disc">
                  {editing.forbiddenHits.map((h) => <li key={h}>{h.startsWith('unsupported_claim: ') ? t('ai.draft.unsupported', { text: h.slice(19) }) : `«${h}»`}</li>)}
                </ul>
              </Alert>
            )}
            {(save.error || submit.error) && <Alert tone="error">{err(save.error ?? submit.error)}</Alert>}
            {editing.channel === 'email' && (
              <Field label={t('ai.draft.subject')} htmlFor="d-subject">
                <Input id="d-subject" name="subject" defaultValue={editing.subject ?? ''} maxLength={200} />
              </Field>
            )}
            <Field label={t('ai.draft.body')} htmlFor="d-body">
              <Textarea id="d-body" name="body" rows={8} defaultValue={editing.body} maxLength={4000} required />
            </Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="submit" variant="secondary" loading={save.isPending}>{t('ai.draft.saveEdits')}</Button>
              <Button
                type="button"
                icon="checkCircle"
                loading={submit.isPending}
                disabled={editing.forbiddenHits.length > 0 || editing.status !== 'draft'}
                onClick={() => submit.mutate(editing.id)}
              >
                {t('ai.draft.submit')}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </AiCard>
  );
}

// ================================================================ visit brief & meeting insights

export function VisitBriefPanel({ visitId }: { visitId: string }) {
  const { t, err, locale } = useI18n();
  const invalidate = useInvalidate();
  const status = useAiStatus();
  const brief = useQuery({ queryKey: ['ai-brief', visitId], queryFn: () => api<VisitBriefDto | Record<string, never>>(`/ai/visits/${visitId}/brief`) });
  const gen = useMutation({
    mutationFn: () => api<VisitBriefDto>(`/ai/visits/${visitId}/brief`, { method: 'POST' }),
    onSuccess: () => {
      invalidate('ai-brief');
      invalidate('ai-status');
    },
  });
  const b = brief.data && 'id' in brief.data ? (brief.data as VisitBriefDto) : null;
  const List = ({ title, items }: { title: string; items: ReactNode[] }) =>
    items.length ? (
      <section>
        <h4 className="mb-1.5 text-sm font-semibold text-fg-sub">{title}</h4>
        <ul className="space-y-1.5 text-sm">{items.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-600" aria-hidden /><div>{x}</div></li>)}</ul>
      </section>
    ) : null;

  return (
    <AiCard
      title={t('ai.brief.title')}
      action={<Button variant={b ? 'secondary' : 'primary'} icon="sparkle" loading={gen.isPending} disabled={!status.data?.available} onClick={() => gen.mutate()}>{t(b ? 'ai.brief.refresh' : 'ai.brief.generate')}</Button>}
    >
      <AiNotice status={status.data} />
      {gen.error && <Alert tone="error">{err(gen.error)}</Alert>}
      {brief.isLoading ? <LoadingState rows={3} /> : !b ? (
        <p className="text-sm text-fg-muted">{t('ai.brief.empty')}</p>
      ) : (
        <div className="animate-fade-up space-y-4">
          {b.content.summary && <p className="text-fg-sub">{b.content.summary}</p>}
          <List title={t('ai.brief.why')} items={b.content.whyTarget} />
          <List title={t('ai.brief.goals')} items={b.content.goals} />
          <List title={t('ai.brief.questions')} items={b.content.questions} />
          <List title={t('ai.brief.value')} items={b.content.valuePoints.map((p) => <>{p.text}<EvidenceChips items={[p.source]} /></>)} />
          <List title={t('ai.brief.objections')} items={b.content.objections.map((o) => <><strong>{o.objection}</strong> — {o.response}<EvidenceChips items={[o.source]} /></>)} />
          <List title={t('ai.brief.cautions')} items={b.content.cautions} />
          {!b.content.valuePoints.length && <Alert tone="info">{t('ai.brief.noBrain')}</Alert>}
          <p className="text-xs text-fg-muted">{formatDate(b.createdAt, locale, true)}</p>
          <Removed items={b.removed} />
        </div>
      )}
    </AiCard>
  );
}

export function MeetingInsightsPanel({ visitId }: { visitId: string }) {
  const { t, err } = useI18n();
  const invalidate = useInvalidate();
  const status = useAiStatus();
  const data = useQuery({ queryKey: ['ai-insights', visitId], queryFn: () => api<MeetingInsightsDto | Record<string, never>>(`/ai/visits/${visitId}/insights`) });
  const gen = useMutation({
    mutationFn: () => api<MeetingInsightsDto>(`/ai/visits/${visitId}/insights`, { method: 'POST' }),
    onSuccess: () => {
      invalidate('ai-insights');
      invalidate('ai-status');
    },
  });
  const m = data.data && 'id' in data.data ? (data.data as MeetingInsightsDto) : null;
  return (
    <AiCard
      title={t('ai.insights.title')}
      action={<Button variant={m ? 'secondary' : 'primary'} icon="sparkle" loading={gen.isPending} disabled={!status.data?.available} onClick={() => gen.mutate()}>{t(m ? 'ai.insights.refresh' : 'ai.insights.generate')}</Button>}
    >
      <AiNotice status={status.data} />
      {gen.error && <Alert tone="error">{err(gen.error)}</Alert>}
      {data.isLoading ? <LoadingState rows={3} /> : !m ? (
        <p className="text-sm text-fg-muted">{t('ai.insights.empty')}</p>
      ) : (
        <div className="animate-fade-up space-y-4 text-sm">
          <p className="text-base text-fg-sub">{m.summary}</p>
          <div className="flex flex-wrap gap-2">
            {m.interestLevel && <Badge tone="brand">{t('ai.insights.interest', { n: m.interestLevel })}</Badge>}
            {m.progressLikelihood !== null && <Badge>{t('ai.insights.likelihood', { p: pct(m.progressLikelihood) })}</Badge>}
          </div>
          <section>
            <h4 className="mb-1.5 font-semibold text-fg-sub">{t('ai.insights.stated')}</h4>
            {m.statedFacts.length ? (
              <ul className="space-y-2">
                {m.statedFacts.map((f, i) => (
                  <li key={i} className="rounded-lg border border-line-soft p-3">
                    <p className="font-medium">{f.value}</p>
                    <blockquote className="mt-1 border-s-2 border-brand-600 ps-2 text-fg-muted">«{f.quote}»</blockquote>
                  </li>
                ))}
              </ul>
            ) : <p className="text-fg-muted">{t('ai.none')}</p>}
          </section>
          <section>
            <h4 className="mb-1.5 font-semibold text-fg-sub">{t('ai.insights.inferred')}</h4>
            {m.inferences.length ? (
              <ul className="space-y-2">
                {m.inferences.map((f, i) => (
                  <li key={i} className="rounded-lg bg-subtle p-3">
                    <p className="font-medium">{f.value} <span className="text-xs font-normal text-fg-muted">· {t('ai.confidence')} {pct(f.confidence)}</span></p>
                    <p className="mt-1 text-fg-muted">{f.reasoning}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-fg-muted">{t('ai.none')}</p>}
          </section>
          {m.nextActions.length > 0 && (
            <section>
              <h4 className="mb-1.5 font-semibold text-fg-sub">{t('ai.insights.next')}</h4>
              <ul className="space-y-1">
                {m.nextActions.map((a, i) => (
                  <li key={i} className={cx('flex justify-between gap-3')}>
                    <span>{a.action}</span>
                    {a.dueInDays !== null && <span className="text-fg-muted">{t('ai.insights.inDays', { n: a.dueInDays })}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Removed items={m.removed} />
        </div>
      )}
    </AiCard>
  );
}
