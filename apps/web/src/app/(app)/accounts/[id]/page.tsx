'use client';

import type React from 'react';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { AccountDto, ActivityDto, ContactDto, NoteDto, OpportunityDto, TaskDto, VisitDto } from '@rakan/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AccountForm } from '@/components/crm/AccountForm';
import { ContactForm, MoveStageForm, OpportunityForm, TaskForm, VisitForm } from '@/components/crm/forms';
import {
  Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, Tabs, Textarea,
  formatDate, formatMoney,
} from '@/components/ui';
import { useConfirm, useToast } from '@/components/feedback';
import { api, ApiError } from '@/lib/api';
import { useCrmSettings } from '@/lib/crm';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate, useMe } from '@/lib/providers';

type Tab = 'overview' | 'contacts' | 'opportunities' | 'visits' | 'tasks' | 'notes' | 'timeline';

export default function AccountPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const { t, err, locale } = useI18n();
  const can = useCan();
  const me = useMe();
  const router = useRouter();
  const invalidate = useInvalidate();
  const settings = useCrmSettings();
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<null | 'edit' | 'contact' | 'opp' | 'visit' | 'task' | { move: OpportunityDto } | { contact: ContactDto } | { dnc: ContactDto }>(null);
  const close = () => setModal(null);

  const account = useQuery({ queryKey: ['account', id], queryFn: () => api<AccountDto>(`/crm/accounts/${id}`) });
  const enabled = account.isSuccess;
  const contacts = useQuery({ queryKey: ['contacts', id], queryFn: () => api<ContactDto[]>(`/crm/accounts/${id}/contacts`), enabled });
  const opps = useQuery({ queryKey: ['opps', id], queryFn: () => api<OpportunityDto[]>(`/crm/opportunities?accountId=${id}`), enabled });
  const range = `from=${new Date(Date.now() - 60 * 86400_000).toISOString()}&to=${new Date(Date.now() + 30 * 86400_000).toISOString()}`;
  const visits = useQuery({ queryKey: ['visits', id], queryFn: () => api<VisitDto[]>(`/crm/visits?accountId=${id}&${range}`), enabled });
  const tasks = useQuery({ queryKey: ['tasks', id], queryFn: () => api<TaskDto[]>(`/crm/tasks?view=all&accountId=${id}`), enabled });
  const notes = useQuery({ queryKey: ['notes', id], queryFn: () => api<NoteDto[]>(`/crm/accounts/${id}/notes`), enabled });
  const timeline = useQuery({ queryKey: ['timeline', id], queryFn: () => api<ActivityDto[]>(`/crm/accounts/${id}/timeline`), enabled: enabled && tab === 'timeline' });

  const refresh = (...keys: string[]) => {
    for (const k of ['account', 'timeline', 'accounts', ...keys]) invalidate(k);
  };
  const remove = useMutation({ mutationFn: () => api(`/crm/accounts/${id}`, { method: 'DELETE' }), onSuccess: () => router.replace('/accounts') });
  const addNote = useMutation({
    mutationFn: (body: string) => api(`/crm/accounts/${id}/notes`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      toast(t('toast.noteAdded'));
      refresh('notes');
    },
  });
  const deleteContact = useMutation({
    mutationFn: (cid: string) => api(`/crm/contacts/${cid}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(t('common.deleted'));
      refresh('contacts');
    },
  });
  const setDnc = useMutation({
    mutationFn: ({ cid, on, reason }: { cid: string; on: boolean; reason?: string }) => api(`/crm/contacts/${cid}/dnc`, { method: 'PUT', body: { doNotContact: on, reason } }),
    onSuccess: () => {
      close();
      toast(t('common.saveSuccess'));
      refresh('contacts');
    },
  });
  const completeTask = useMutation({
    mutationFn: (tid: string) => api(`/crm/tasks/${tid}`, { method: 'PATCH', body: { status: 'done' } }),
    onSuccess: () => {
      toast(t('toast.taskDone'));
      refresh('tasks');
    },
  });

  if (account.isLoading) return <LoadingState card />;
  if (account.error) return account.error instanceof ApiError && account.error.status === 404 ? <Alert tone="error">{t('errors.NOT_FOUND')}</Alert> : <ErrorState error={account.error} onRetry={() => account.refetch()} />;
  const a = account.data!;
  // Reps may only change accounts assigned to them (the API enforces this too).
  const canWrite = can('crm.account.write') && (me.data?.activeTenant?.role !== 'rep' || me.data.activeTenant.membershipId === a.ownerMembershipId);
  const pipelineFor = (o: OpportunityDto) => settings.data?.pipelines.find((p) => p.id === o.pipelineId);
  const stageName = (o: OpportunityDto) => pipelineFor(o)?.stages.find((s) => s.id === o.stageId)?.name ?? '—';
  const track = settings.data?.tracks.find((x) => x.id === a.trackId);
  const defs = (settings.data?.customFields ?? []).filter((f) => f.entity === 'account' && (!f.trackId || f.trackId === a.trackId));

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: t('accounts.tab.overview') },
    { id: 'contacts', label: t('accounts.tab.contacts'), count: contacts.data?.length },
    { id: 'opportunities', label: t('accounts.tab.opportunities'), count: opps.data?.length },
    { id: 'visits', label: t('accounts.tab.visits'), count: visits.data?.length },
    { id: 'tasks', label: t('accounts.tab.tasks'), count: tasks.data?.length },
    { id: 'notes', label: t('accounts.tab.notes'), count: notes.data?.length },
    { id: 'timeline', label: t('accounts.tab.timeline') },
  ];

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex flex-wrap justify-between gap-2 py-2.5 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-medium">{value || '—'}</dd>
    </div>
  );

  return (
    <>
      <header className="mb-4">
        <Link href="/accounts" className="text-sm text-brand-700 hover:underline">← {t('accounts.title')}</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{a.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              <Badge tone={a.status === 'customer' ? 'brand' : a.status === 'active' ? 'neutral' : 'muted'}>{t(`accounts.status.${a.status}` as MessageKey)}</Badge>
              {track && <Badge>{track.name}</Badge>}
              <span>{a.ownerName ?? t('common.unassigned')}</span>
              {a.city && <span>· {a.city}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {can('crm.visit.write') && canWrite && <Button variant="secondary" onClick={() => setModal('visit')}>{t('visits.new')}</Button>}
            {canWrite && <Button variant="secondary" onClick={() => setModal('edit')}>{t('common.edit')}</Button>}
            {can('crm.account.delete') && (
              <Button variant="danger" loading={remove.isPending} onClick={() => void confirm({ title: t('accounts.confirmDelete', { name: a.name }), tone: 'danger', confirmLabel: t('common.delete') }).then((ok) => ok && remove.mutate())}>
                {t('common.delete')}
              </Button>
            )}
          </div>
        </div>
      </header>
      {(remove.error || deleteContact.error || completeTask.error || setDnc.error) && (
        <div className="mb-4"><Alert tone="error">{err(remove.error ?? deleteContact.error ?? completeTask.error ?? setDnc.error)}</Alert></div>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} label={a.name} />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="px-5 py-2">
            <dl className="divide-y divide-line-soft">
              <Row label={t('accounts.cr')} value={<bdi>{a.crNumber}</bdi>} />
              <Row label={t('accounts.vat')} value={<bdi>{a.vatNumber}</bdi>} />
              <Row label={t('accounts.phone')} value={a.phone && <a href={`tel:${a.phone}`} className="text-brand-700" dir="ltr">{a.phone}</a>} />
              <Row label={t('accounts.website')} value={a.websiteDomain && <a href={`https://${a.websiteDomain}`} target="_blank" rel="noopener noreferrer" className="text-brand-700" dir="ltr">{a.websiteDomain}</a>} />
              <Row label={t('accounts.industry')} value={a.industry} />
              <Row label={t('accounts.region')} value={a.region} />
              <Row label={t('accounts.address')} value={a.address} />
            </dl>
          </Card>
          <Card className="px-5 py-2">
            <dl className="divide-y divide-line-soft">
              <Row label={t('accounts.source')} value={`${t(`accounts.source.${a.leadSource}` as MessageKey)}${a.leadSourceDetail ? ` — ${a.leadSourceDetail}` : ''}`} />
              <Row label={t('accounts.lastActivity')} value={a.lastActivityAt && formatDate(a.lastActivityAt, locale, true)} />
              <Row label={t('accounts.openOpps')} value={String(opps.data?.filter((o) => o.stageCategory === 'open').length ?? '—')} />
              {defs.map((d) => {
                const v = a.customFields[d.key];
                return <Row key={d.id} label={d.label} value={v === undefined ? null : typeof v === 'boolean' ? t(v ? 'common.yes' : 'common.no') : String(v)} />;
              })}
            </dl>
          </Card>
        </div>
      )}

      {tab === 'contacts' && (
        <Card>
          {canWrite && <div className="flex justify-end border-b border-line-soft p-3"><Button onClick={() => setModal('contact')}>{t('contacts.new')}</Button></div>}
          {contacts.data?.length ? (
            <ul className="stagger divide-y divide-line-soft">
              {contacts.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {c.fullName} {c.isPrimary && <Badge tone="brand">{t('contacts.primary')}</Badge>} {c.doNotContact && <Badge tone="warn">{t('contacts.dncBadge')}</Badge>}
                    </p>
                    <p className="text-sm text-fg-muted">{c.jobTitle}</p>
                    <p className="mt-1 flex flex-wrap gap-3 text-sm">
                      {c.phone && !c.doNotContact && <a className="text-brand-700" href={`tel:${c.phone}`} dir="ltr">{c.phone}</a>}
                      {c.phone && c.doNotContact && <span className="text-fg-muted" dir="ltr">{c.phone}</span>}
                      {c.email && <bdi className="text-fg-sub">{c.email}</bdi>}
                    </p>
                    {c.doNotContact && c.dncReason && <p className="mt-1 text-xs text-warn">{c.dncReason}</p>}
                  </div>
                  {canWrite && (
                    <div className="flex flex-wrap gap-1">
                      <Button variant="ghost" onClick={() => setModal({ contact: c })}>{t('common.edit')}</Button>
                      <Button variant="ghost" onClick={() => (c.doNotContact ? setDnc.mutate({ cid: c.id, on: false }) : setModal({ dnc: c }))}>
                        {c.doNotContact ? t('contacts.dncOff') : t('contacts.dncOn')}
                      </Button>
                      <Button variant="ghost" className="text-danger" onClick={() => void confirm({ title: t('contacts.confirmDelete', { name: c.fullName }), tone: 'danger', confirmLabel: t('common.delete') }).then((ok) => ok && deleteContact.mutate(c.id))}>
                        {t('common.delete')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>{t('contacts.empty')}</EmptyState>
          )}
        </Card>
      )}

      {tab === 'opportunities' && (
        <Card>
          {can('crm.opportunity.write') && canWrite && <div className="flex justify-end border-b border-line-soft p-3"><Button onClick={() => setModal('opp')}>{t('opps.new')}</Button></div>}
          {opps.data?.length ? (
            <ul className="stagger divide-y divide-line-soft">
              {opps.data.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{o.title}</p>
                    <p className="text-sm text-fg-muted">{formatMoney(o.amount, locale)} · {o.ownerName ?? t('common.unassigned')}</p>
                  </div>
                  <Badge tone={o.stageCategory === 'won' ? 'brand' : o.stageCategory === 'open' ? 'neutral' : 'muted'}>{stageName(o)}</Badge>
                  {can('crm.opportunity.write') && pipelineFor(o) && <Button variant="secondary" onClick={() => setModal({ move: o })}>{t('opps.moveTo')}</Button>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>{t('opps.empty')}</EmptyState>
          )}
        </Card>
      )}

      {tab === 'visits' && (
        <Card>
          {visits.data?.length ? (
            <ul className="stagger divide-y divide-line-soft">
              {visits.data.map((v) => (
                <li key={v.id}>
                  <Link href={`/visits/${v.id}`} className="flex flex-wrap items-center gap-3 px-5 py-4 transition-colors duration-150 hover:bg-subtle">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{formatDate(v.scheduledStart, locale, true)}</p>
                      <p className="text-sm text-fg-muted">{[v.repName, v.purpose].filter(Boolean).join(' · ')}</p>
                    </div>
                    <Badge tone={v.status === 'completed' ? 'brand' : v.status === 'cancelled' ? 'muted' : 'neutral'}>{t(`visits.status.${v.status}`)}</Badge>
                    {v.outcome && <Badge>{t(`visits.outcome.${v.outcome}` as MessageKey)}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>{t('visits.empty')}</EmptyState>
          )}
        </Card>
      )}

      {tab === 'tasks' && (
        <Card>
          {can('crm.task.write') && <div className="flex justify-end border-b border-line-soft p-3"><Button onClick={() => setModal('task')}>{t('tasks.new')}</Button></div>}
          {tasks.data?.length ? (
            <ul className="stagger divide-y divide-line-soft">
              {tasks.data.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{x.title}</p>
                    <p className="text-sm text-fg-muted">{[t(`tasks.type.${x.type}` as MessageKey), x.assigneeName, x.dueAt && formatDate(x.dueAt, locale, true)].filter(Boolean).join(' · ')}</p>
                  </div>
                  {x.dueAt && new Date(x.dueAt) < new Date() && <Badge tone="warn">{t('tasks.overdue')}</Badge>}
                  {can('crm.task.write') && <Button variant="secondary" loading={completeTask.isPending && completeTask.variables === x.id} onClick={() => completeTask.mutate(x.id)}>{t('tasks.markDone')}</Button>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>{t('tasks.empty')}</EmptyState>
          )}
        </Card>
      )}

      {tab === 'notes' && (
        <Card>
          {canWrite && (
            <form
              className="space-y-2 border-b border-line-soft p-4"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const form = e.currentTarget;
                const body = String(new FormData(form).get('body') ?? '').trim();
                if (body) addNote.mutate(body, { onSuccess: () => form.reset() });
              }}
            >
              <label htmlFor="note-body" className="sr-only">{t('common.notes')}</label>
              <Textarea id="note-body" name="body" rows={3} placeholder={t('notes.placeholder')} />
              <div className="flex justify-end"><Button type="submit" loading={addNote.isPending}>{t('common.add')}</Button></div>
            </form>
          )}
          {notes.data?.length ? (
            <ul className="stagger divide-y divide-line-soft">
              {notes.data.map((n) => (
                <li key={n.id} className="px-5 py-4">
                  <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                  <p className="mt-1 text-xs text-fg-muted">{n.authorName} · {formatDate(n.createdAt, locale, true)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>{t('notes.empty')}</EmptyState>
          )}
        </Card>
      )}

      {tab === 'timeline' && (
        <Card>
          {timeline.isLoading ? <LoadingState /> : timeline.data?.length ? (
            <ol className="stagger divide-y divide-line-soft">
              {timeline.data.map((e) => (
                <li key={e.id} className="flex gap-3 px-5 py-3">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${e.actorType === 'system' ? 'bg-fg-muted' : 'bg-brand-600'}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(`timeline.${e.type}` as MessageKey)}{e.summary ? `: ${e.summary}` : ''}</p>
                    <p className="text-xs text-fg-muted">{e.actorName ?? t('audit.system')} · {formatDate(e.occurredAt, locale, true)}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState>{t('timeline.empty')}</EmptyState>
          )}
        </Card>
      )}

      <Modal open={modal === 'edit'} onClose={close} title={t('accounts.edit')} size="lg">
        <AccountForm account={a} onCancel={close} onSaved={() => { close(); toast(t('common.saveSuccess')); refresh(); }} />
      </Modal>
      <Modal open={modal === 'contact' || (!!modal && typeof modal === 'object' && 'contact' in modal)} onClose={close} title={t('contacts.new')} size="lg">
        <ContactForm accountId={id} contact={modal && typeof modal === 'object' && 'contact' in modal ? modal.contact : undefined} onCancel={close} onDone={() => { close(); toast(t('common.saveSuccess')); refresh('contacts'); }} />
      </Modal>
      <Modal open={modal === 'opp'} onClose={close} title={t('opps.new')}>
        <OpportunityForm accountId={id} onCancel={close} onDone={() => { close(); toast(t('toast.created')); refresh('opps'); }} />
      </Modal>
      <Modal open={modal === 'visit'} onClose={close} title={t('visits.new')} size="lg">
        <VisitForm accountId={id} opportunities={opps.data} onCancel={close} onDone={() => { close(); toast(t('toast.created')); refresh('visits', 'opps'); setTab('visits'); }} />
      </Modal>
      <Modal open={modal === 'task'} onClose={close} title={t('tasks.new')}>
        <TaskForm accountId={id} onCancel={close} onDone={() => { close(); toast(t('toast.created')); refresh('tasks'); }} />
      </Modal>
      <Modal open={!!modal && typeof modal === 'object' && 'move' in modal} onClose={close} title={t('opps.moveTo')}>
        {modal && typeof modal === 'object' && 'move' in modal && pipelineFor(modal.move) && (
          <MoveStageForm opportunity={modal.move} pipeline={pipelineFor(modal.move)!} onCancel={close} onDone={(o) => { close(); toast(t('toast.stageMoved', { stage: stageName(o) })); refresh('opps'); }} />
        )}
      </Modal>
      <Modal open={!!modal && typeof modal === 'object' && 'dnc' in modal} onClose={close} title={t('contacts.dncOn')}>
        {modal && typeof modal === 'object' && 'dnc' in modal && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setDnc.mutate({ cid: modal.dnc.id, on: true, reason: String(new FormData(e.currentTarget).get('reason') ?? '') || undefined });
            }}
          >
            <p className="text-sm">{modal.dnc.fullName}</p>
            <Field label={t('contacts.dncReason')} htmlFor="dnc-reason" optional>
              <Input id="dnc-reason" name="reason" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={close}>{t('common.cancel')}</Button>
              <Button type="submit" loading={setDnc.isPending}>{t('common.confirm')}</Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
