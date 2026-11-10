'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { BRAIN_SECTIONS, type BrainDocumentDto, type BrainItemDto, type BrainOverviewDto, type BrainSection } from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import { useConfirm, useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import {
  Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, NoPermission, PageHeader, Select, Tabs, Textarea, cx, formatDate,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

type Tab = 'knowledge' | 'documents';
const STATUS_TONE = { draft: 'neutral', pending_confirmation: 'warn', approved: 'success', archived: 'muted' } as const;
const TRUST_TONE = { unverified: 'warn', approved: 'success', suspicious: 'danger' } as const;

/** Structured inputs for sections whose facts the assistant must quote exactly. */
function SectionFields({ section, fields }: { section: BrainSection; fields: Record<string, unknown> }) {
  const { t } = useI18n();
  const v = (k: string) => (fields[k] === undefined || fields[k] === null ? '' : String(fields[k]));
  const num = (k: string, label: MessageKey, extra: object = {}) => (
    <Field label={t(label)} htmlFor={`f-${k}`}><Input id={`f-${k}`} name={`f.${k}`} type="number" step="any" min={0} dir="ltr" defaultValue={v(k)} required {...extra} /></Field>
  );
  const txt = (k: string, label: MessageKey, opt = false) => (
    <Field label={t(label)} htmlFor={`f-${k}`} optional={opt}><Input id={`f-${k}`} name={`f.${k}`} defaultValue={v(k)} required={!opt} /></Field>
  );
  switch (section) {
    case 'pricing':
      return <div className="grid gap-4 sm:grid-cols-3">{txt('product', 'brain.f.product')}{num('price', 'brain.f.price')}{txt('unit', 'brain.f.unit', true)}</div>;
    case 'objections':
      return (
        <div className="space-y-4">
          {txt('objection', 'brain.f.objection')}
          <Field label={t('brain.f.response')} htmlFor="f-response"><Textarea id="f-response" name="f.response" rows={3} defaultValue={v('response')} required /></Field>
        </div>
      );
    case 'forbidden':
      return txt('phrase', 'brain.f.phrase');
    case 'discount_rules':
      return <div className="grid gap-4 sm:grid-cols-2">{num('maxDiscountPctRep', 'brain.f.repMax', { max: 100 })}{num('maxDiscountPctManager', 'brain.f.mgrMax', { max: 100 })}</div>;
    case 'competitors':
      return txt('name', 'brain.f.competitor');
    default:
      return null;
  }
}

function readFields(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of fd.entries()) {
    if (!k.startsWith('f.')) continue;
    const key = k.slice(2);
    const s = String(raw).trim();
    if (!s) continue;
    out[key] = ['price', 'maxDiscountPctRep', 'maxDiscountPctManager'].includes(key) ? Number(s) : s;
  }
  return out;
}

export default function BrainPage() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const [tab, setTab] = useState<Tab>('knowledge');
  const [section, setSection] = useState<BrainSection | 'all'>('all');
  const [editing, setEditing] = useState<BrainItemDto | 'new' | null>(null);
  const [newSection, setNewSection] = useState<BrainSection>('company_profile');
  const [history, setHistory] = useState<BrainItemDto | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const manage = can('brain.manage');

  const data = useQuery({ queryKey: ['brain'], queryFn: () => api<BrainOverviewDto>('/brain'), enabled: can('brain.read') });
  const versions = useQuery({
    queryKey: ['brain-versions', history?.id],
    queryFn: () => api<{ version: number; title: string; body: string; status: string; changedByName: string | null; changedAt: string }[]>(`/brain/items/${history!.id}/versions`),
    enabled: !!history,
  });
  const done = (msg: MessageKey = 'common.saveSuccess') => {
    toast(t(msg));
    invalidate('brain');
  };
  const save = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: object }) => (id ? api(`/brain/items/${id}`, { method: 'PATCH', body }) : api('/brain/items', { method: 'POST', body })),
    onSuccess: () => {
      setEditing(null);
      done();
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'archive' }) => api(`/brain/items/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_, v) => done(v.action === 'approve' ? 'brain.approved' : 'brain.archived'),
  });
  const addDoc = useMutation({
    mutationFn: (body: object) => api<BrainDocumentDto>('/brain/documents', { method: 'POST', body }),
    onSuccess: (d) => {
      setDocOpen(false);
      done(d.trustLevel === 'suspicious' ? 'brain.doc.flaggedToast' : 'common.saveSuccess');
    },
  });
  const docAct = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'delete' }) =>
      action === 'approve' ? api(`/brain/documents/${id}/approve`, { method: 'POST' }) : api(`/brain/documents/${id}`, { method: 'DELETE' }),
    onSuccess: (_, v) => done(v.action === 'approve' ? 'brain.approved' : 'common.deleted'),
  });

  if (!can('brain.read')) return <NoPermission />;
  if (data.isLoading) return <LoadingState card rows={6} />;
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />;
  const d = data.data!;
  const titleOf = (id: string) => d.items.find((i) => i.id === id)?.title ?? '—';
  const visible = d.items.filter((i) => (section === 'all' ? i.status !== 'archived' : i.section === section));
  const approvedSections = d.coverage.filter((c) => c.approved > 0).length;

  function submitItem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = {
      title: String(fd.get('title') ?? ''), body: String(fd.get('body') ?? ''), fields: readFields(fd),
      ...(editing === 'new' ? { section: newSection, status: fd.get('confirm') === 'on' ? 'pending_confirmation' : 'draft' } : {}),
    };
    save.mutate({ id: editing !== 'new' && editing ? editing.id : undefined, body });
  }

  async function readFile(file: File, form: HTMLFormElement) {
    const text = await file.text();
    (form.elements.namedItem('content') as HTMLTextAreaElement).value = text;
    const title = form.elements.namedItem('title') as HTMLInputElement;
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '');
  }

  const sectionItem = editing === 'new' ? newSection : editing?.section;

  return (
    <>
      <PageHeader
        title={t('brain.title')}
        subtitle={t('brain.subtitle')}
        actions={manage && (tab === 'knowledge'
          ? <Button icon="plus" onClick={() => { save.reset(); setNewSection(section === 'all' ? 'company_profile' : section); setEditing('new'); }}>{t('brain.add')}</Button>
          : <Button icon="upload" onClick={() => { addDoc.reset(); setDocOpen(true); }}>{t('brain.doc.add')}</Button>)}
      />

      <Alert tone="info">{t('brain.onlyApproved')}</Alert>
      {d.conflicts.length > 0 && (
        <div className="mt-3">
          <Alert tone="warn">
            <p className="font-medium">{t('brain.conflicts', { n: d.conflicts.length })}</p>
            <ul className="mt-1 list-inside list-disc">
              {d.conflicts.map((c, i) => <li key={i}>{t(`brain.conflict.${c.reason}` as MessageKey)}: «{titleOf(c.a)}» ↔ «{titleOf(c.b)}»</li>)}
            </ul>
          </Alert>
        </div>
      )}

      <div className="mt-5">
        <Tabs<Tab>
          tabs={[{ id: 'knowledge', label: t('brain.tab.knowledge'), count: d.items.filter((i) => i.status !== 'archived').length }, { id: 'documents', label: t('brain.tab.documents'), count: d.documents.length }]}
          value={tab}
          onChange={setTab}
          label={t('brain.title')}
        />
      </div>

      {tab === 'knowledge' && (
        <div className="grid gap-5 lg:grid-cols-[17rem_1fr]">
          <Card className="h-fit min-w-0 p-3">
            <p className="px-2 pb-2 text-xs text-fg-muted">{t('brain.coverage', { n: approvedSections, total: BRAIN_SECTIONS.length })}</p>
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-subtle-strong" aria-hidden>
              <div className="h-full origin-right ltr:origin-left rounded-full bg-success transition-transform duration-300" style={{ transform: `scaleX(${approvedSections / BRAIN_SECTIONS.length})` }} />
            </div>
            <nav aria-label={t('brain.sections')} className="flex gap-1 overflow-x-auto lg:flex-col">
              {[{ section: 'all' as const, approved: 0, total: d.items.filter((i) => i.status !== 'archived').length }, ...d.coverage].map((c) => (
                <button
                  key={c.section}
                  aria-current={section === c.section ? 'true' : undefined}
                  onClick={() => setSection(c.section)}
                  className={cx(
                    'flex min-h-10 shrink-0 items-center justify-between gap-3 rounded-lg px-3 text-start text-sm transition-colors duration-150',
                    section === c.section ? 'bg-brand-50 font-semibold text-brand-700' : 'text-fg-sub hover:bg-subtle-strong',
                  )}
                >
                  <span className="truncate">{c.section === 'all' ? t('brain.all') : t(`brain.section.${c.section}` as MessageKey)}</span>
                  {c.section !== 'all' && c.approved > 0 ? <Icon name="checkCircle" size={16} className="text-success" /> : <span className="text-xs text-fg-muted">{c.total || ''}</span>}
                </button>
              ))}
            </nav>
          </Card>

          <div className="min-w-0 space-y-3">
            {section !== 'all' && <p className="text-sm text-fg-muted">{t(`brain.hint.${section}` as MessageKey)}</p>}
            {act.error && <Alert tone="error">{err(act.error)}</Alert>}
            {visible.length === 0 ? (
              <EmptyState icon="sparkle" action={manage && <Button variant="secondary" icon="plus" onClick={() => { setNewSection(section === 'all' ? 'company_profile' : section); setEditing('new'); }}>{t('brain.add')}</Button>}>
                {t('brain.empty')}
              </EmptyState>
            ) : (
              <ul className="stagger space-y-3">
                {visible.map((it) => (
                  <li key={it.id}>
                    <Card className="p-4 sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-fg-muted">{t(`brain.section.${it.section}` as MessageKey)} · v{it.version}</p>
                          <h3 className="font-semibold">{it.title}</h3>
                        </div>
                        <Badge tone={STATUS_TONE[it.status]} dot>{t(`brain.status.${it.status}` as MessageKey)}</Badge>
                      </div>
                      {Object.keys(it.fields).length > 0 && (
                        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                          {Object.entries(it.fields).map(([k, v]) => <div key={k}><dt className="inline text-fg-muted">{t(`brain.fk.${k}` as MessageKey)}: </dt><dd className="inline font-medium">{String(v)}</dd></div>)}
                        </dl>
                      )}
                      {it.body && <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-fg-sub">{it.body}</p>}
                      {it.conflicts.length > 0 && <p className="mt-2 text-sm text-warn">⚠ {t('brain.hasConflict')}</p>}
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3 text-xs text-fg-muted">
                        <span>{it.approvedByName ? t('brain.approvedBy', { name: it.approvedByName }) : formatDate(it.updatedAt, locale)}</span>
                        <span className="flex-1" />
                        <Button variant="ghost" className="min-h-9" onClick={() => setHistory(it)}>{t('brain.history')}</Button>
                        {manage && it.status !== 'archived' && (
                          <>
                            <Button variant="ghost" className="min-h-9" onClick={() => { save.reset(); setEditing(it); }}>{t('common.edit')}</Button>
                            <Button variant="ghost" className="min-h-9" loading={act.isPending && act.variables?.id === it.id && act.variables.action === 'archive'} onClick={() => void confirm({ title: t('brain.archiveConfirm'), tone: 'default', confirmLabel: t('brain.archive') }).then((ok) => ok && act.mutate({ id: it.id, action: 'archive' }))}>{t('brain.archive')}</Button>
                            {it.status !== 'approved' && (
                              <Button className="min-h-9" icon="check" loading={act.isPending && act.variables?.id === it.id && act.variables.action === 'approve'} onClick={() => act.mutate({ id: it.id, action: 'approve' })}>{t('brain.approve')}</Button>
                            )}
                          </>
                        )}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">{t('brain.doc.hint')}</p>
          {docAct.error && <Alert tone="error">{err(docAct.error)}</Alert>}
          {d.documents.length === 0 ? <EmptyState icon="inbox">{t('brain.doc.empty')}</EmptyState> : (
            <ul className="stagger space-y-3">
              {d.documents.map((doc) => (
                <li key={doc.id}>
                  <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="font-medium">{doc.title}</p>
                      <p className="text-xs text-fg-muted">{t('brain.doc.chars', { n: doc.chars.toLocaleString(locale) })} · {formatDate(doc.createdAt, locale)}</p>
                      {doc.injectionFlags.length > 0 && <p className="mt-1 text-sm text-danger">{t('brain.doc.flagged')}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={TRUST_TONE[doc.trustLevel]} dot>{t(`brain.trust.${doc.trustLevel}` as MessageKey)}</Badge>
                      {manage && doc.trustLevel === 'unverified' && <Button className="min-h-9" icon="check" onClick={() => docAct.mutate({ id: doc.id, action: 'approve' })}>{t('brain.approve')}</Button>}
                      {manage && (
                        <Button variant="ghost" className="min-h-9 text-danger" onClick={() => void confirm({ title: t('brain.doc.deleteConfirm'), tone: 'danger', confirmLabel: t('common.delete') }).then((ok) => ok && docAct.mutate({ id: doc.id, action: 'delete' }))}>
                          {t('common.delete')}
                        </Button>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? t('brain.add') : t('common.edit')} size="lg">
        {editing && sectionItem && (
          <form key={editing === 'new' ? `new-${newSection}` : editing.id} onSubmit={submitItem} className="space-y-4">
            {editing !== 'new' && editing.status === 'approved' && <Alert tone="info">{t('brain.editApproved')}</Alert>}
            {save.error && <Alert tone="error">{err(save.error)}</Alert>}
            {editing === 'new' && (
              <Field label={t('brain.section')} htmlFor="b-section">
                <Select id="b-section" value={newSection} onChange={(e) => setNewSection(e.target.value as BrainSection)}>
                  {BRAIN_SECTIONS.map((s) => <option key={s} value={s}>{t(`brain.section.${s}` as MessageKey)}</option>)}
                </Select>
              </Field>
            )}
            <p className="text-sm text-fg-muted">{t(`brain.hint.${sectionItem}` as MessageKey)}</p>
            <Field label={t('brain.itemTitle')} htmlFor="b-title"><Input id="b-title" name="title" defaultValue={editing === 'new' ? '' : editing.title} required minLength={2} maxLength={200} /></Field>
            <SectionFields section={sectionItem} fields={editing === 'new' ? {} : editing.fields} />
            <Field label={t('brain.itemBody')} htmlFor="b-body" optional><Textarea id="b-body" name="body" rows={6} defaultValue={editing === 'new' ? '' : editing.body} maxLength={10000} /></Field>
            {editing === 'new' && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" className="size-4 accent-brand-600" /> {t('brain.sendForConfirmation')}</label>
            )}
            <Button type="submit" className="w-full" loading={save.isPending}>{t('common.save')}</Button>
          </form>
        )}
      </Modal>

      <Modal open={docOpen} onClose={() => setDocOpen(false)} title={t('brain.doc.add')} size="lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            addDoc.mutate({ title: String(fd.get('title') ?? ''), content: String(fd.get('content') ?? '') });
          }}
        >
          <p className="text-sm text-fg-muted">{t('brain.doc.formHint')}</p>
          {addDoc.error && <Alert tone="error">{err(addDoc.error)}</Alert>}
          <Field label={t('brain.doc.title')} htmlFor="doc-title"><Input id="doc-title" name="title" required minLength={2} maxLength={200} /></Field>
          <Field label={t('brain.doc.file')} htmlFor="doc-file" optional>
            <Input id="doc-file" type="file" accept=".txt,.md,.csv,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f, e.currentTarget.form!); }} />
          </Field>
          <Field label={t('brain.doc.content')} htmlFor="doc-content"><Textarea id="doc-content" name="content" rows={10} required minLength={10} maxLength={200000} /></Field>
          <Button type="submit" className="w-full" loading={addDoc.isPending}>{t('common.save')}</Button>
        </form>
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title={t('brain.history')}>
        {versions.isLoading ? <LoadingState rows={3} /> : (
          <ol className="space-y-3">
            {versions.data?.map((v, i) => (
              <li key={i} className="rounded-lg border border-line-soft p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>v{v.version} · {t(`brain.status.${v.status}` as MessageKey)}</strong>
                  <span className="text-fg-muted">{v.changedByName ?? '—'} · {formatDate(v.changedAt, locale, true)}</span>
                </div>
                <p className="mt-1 font-medium">{v.title}</p>
                {v.body && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-fg-muted">{v.body}</p>}
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </>
  );
}
