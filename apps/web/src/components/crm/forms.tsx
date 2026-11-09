'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  TASK_TYPES, contactSchema, opportunitySchema, taskSchema, visitSchema,
  type AccountDto, type ContactDto, type OpportunityDto, type Paged, type PipelineDto, type StageDto, type TaskDto, type VisitDto,
} from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select, Textarea, fromLocalInput, toLocalInput } from '@/components/ui';
import { api } from '@/lib/api';
import { isoDaysFromNow, useCrmSettings, useMembers } from '@/lib/crm';
import { validate, type FieldErrors } from '@/lib/forms';
import { useCan, useI18n, useMe } from '@/lib/providers';

const opt = (fd: FormData, k: string) => {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
};

function Actions({ onCancel, pending, label }: { onCancel: () => void; pending: boolean; label?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
      <Button type="submit" loading={pending}>{label ?? t('common.save')}</Button>
    </div>
  );
}

/** Account picker with server-side search (used when the account is not fixed). */
export function AccountPicker({ name, value, onChange }: { name: string; value?: string; onChange?: (id: string) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const res = useQuery({
    queryKey: ['account-picker', q],
    queryFn: () => api<Paged<AccountDto>>(`/crm/accounts?pageSize=20&sort=name${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  return (
    <div className="space-y-2">
      <Input type="search" aria-label={t('common.search')} placeholder={t('accounts.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
      <Select id={name} name={name} defaultValue={value} onChange={(e) => onChange?.(e.target.value)} required>
        <option value="">—</option>
        {res.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}{a.city ? ` — ${a.city}` : ''}</option>)}
      </Select>
    </div>
  );
}

export function OpportunityForm({ accountId, onDone, onCancel }: { accountId?: string; onDone: (o: OpportunityDto) => void; onCancel: () => void }) {
  const { t, err } = useI18n();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({ mutationFn: (body: object) => api<OpportunityDto>('/crm/opportunities', { method: 'POST', body }), onSuccess: onDone });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const amount = opt(fd, 'amount');
    const v = validate(opportunitySchema, {
      accountId: accountId ?? opt(fd, 'accountId'), title: String(fd.get('title') ?? '').trim(),
      amount: amount === null ? null : Number(amount), expectedCloseDate: opt(fd, 'expectedCloseDate'),
    });
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate(v.data);
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {m.error && <Alert tone="error">{err(m.error)}</Alert>}
      {!accountId && (
        <Field label={t('visits.account')} htmlFor="opp-account" error={errors.accountId && t(errors.accountId.key)}>
          <AccountPicker name="accountId" />
        </Field>
      )}
      <Field label={t('opps.title')} htmlFor="opp-title" error={errors.title && t(errors.title.key, errors.title.vars)}>
        <Input id="opp-title" name="title" autoFocus />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${t('opps.amount')} (${t('common.sar')})`} htmlFor="opp-amount" optional>
          <Input id="opp-amount" name="amount" type="number" min={0} step="1" inputMode="numeric" dir="ltr" />
        </Field>
        <Field label={t('opps.expectedClose')} htmlFor="opp-close" optional>
          <Input id="opp-close" name="expectedCloseDate" type="date" />
        </Field>
      </div>
      <Actions onCancel={onCancel} pending={m.isPending} />
    </form>
  );
}

/** Stage move. Won/lost/postponed require a reason (enforced by the API too). */
export function MoveStageForm({
  opportunity, pipeline, targetStageId, onDone, onCancel,
}: { opportunity: OpportunityDto; pipeline: PipelineDto; targetStageId?: string; onDone: (o: OpportunityDto) => void; onCancel: () => void }) {
  const { t, err } = useI18n();
  const settings = useCrmSettings();
  const [stageId, setStageId] = useState(targetStageId ?? opportunity.stageId);
  const stage: StageDto | undefined = pipeline.stages.find((s) => s.id === stageId);
  const kind = stage?.category === 'won' ? 'win' : stage?.category === 'lost' ? 'loss' : stage?.category === 'postponed' ? 'postpone' : null;
  const reasons = settings.data?.reasons.filter((r) => r.kind === kind && r.isActive) ?? [];
  const [reasonMissing, setReasonMissing] = useState(false);
  const m = useMutation({
    mutationFn: (body: object) => api<OpportunityDto>(`/crm/opportunities/${opportunity.id}/stage`, { method: 'POST', body }),
    onSuccess: onDone,
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const reason = opt(fd, 'reason');
    setReasonMissing(!!kind && !reason);
    if (kind && !reason) return;
    m.mutate({ stageId, outcomeReasonId: reason, note: opt(fd, 'note') });
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {m.error && <Alert tone="error">{err(m.error)}</Alert>}
      <p className="text-sm text-ink-500">{opportunity.accountName} — {opportunity.title}</p>
      <Field label={t('opps.moveTo')} htmlFor="mv-stage">
        <Select id="mv-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
          {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      {kind && (
        <>
          <Field label={t('opps.reason')} htmlFor="mv-reason" hint={t('opps.reasonRequired')} error={reasonMissing ? t('opps.reasonRequired') : undefined}>
            <Select id="mv-reason" name="reason" required aria-invalid={reasonMissing} defaultValue="">
              <option value="" disabled>—</option>
              {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
          </Field>
          <Field label={t('opps.outcomeNote')} htmlFor="mv-note" optional>
            <Textarea id="mv-note" name="note" rows={2} />
          </Field>
        </>
      )}
      <Actions onCancel={onCancel} pending={m.isPending} label={t('common.confirm')} />
    </form>
  );
}

export function TaskForm({ accountId, onDone, onCancel }: { accountId?: string; onDone: (t: TaskDto) => void; onCancel: () => void }) {
  const { t, err } = useI18n();
  const can = useCan();
  const me = useMe();
  const members = useMembers();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({ mutationFn: (body: object) => api<TaskDto>('/crm/tasks', { method: 'POST', body }), onSuccess: onDone });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = validate(taskSchema, {
      title: String(fd.get('title') ?? '').trim(), type: String(fd.get('type')), priority: String(fd.get('priority')),
      dueAt: fromLocalInput(String(fd.get('dueAt') ?? '')), accountId: accountId ?? null,
      ...(can('team.member.read') ? { assigneeMembershipId: opt(fd, 'assignee') } : {}),
    });
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate(v.data);
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {m.error && <Alert tone="error">{err(m.error)}</Alert>}
      <Field label={t('tasks.taskTitle')} htmlFor="task-title" error={errors.title && t(errors.title.key, errors.title.vars)}>
        <Input id="task-title" name="title" autoFocus />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('tasks.type')} htmlFor="task-type">
          <Select id="task-type" name="type" defaultValue="follow_up">
            {TASK_TYPES.map((x) => <option key={x} value={x}>{t(`tasks.type.${x}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('tasks.priority')} htmlFor="task-priority">
          <Select id="task-priority" name="priority" defaultValue="normal">
            {(['low', 'normal', 'high'] as const).map((x) => <option key={x} value={x}>{t(`tasks.priority.${x}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('tasks.due')} htmlFor="task-due" optional>
          <Input id="task-due" name="dueAt" type="datetime-local" defaultValue={toLocalInput(isoDaysFromNow(1))} />
        </Field>
        {can('team.member.read') && (
          <Field label={t('tasks.assignee')} htmlFor="task-assignee">
            <Select id="task-assignee" name="assignee" defaultValue={members.data?.find((x) => x.userId === me.data?.user.id)?.id}>
              {members.data?.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <Actions onCancel={onCancel} pending={m.isPending} />
    </form>
  );
}

export function VisitForm({
  accountId, opportunities, onDone, onCancel,
}: { accountId?: string; opportunities?: OpportunityDto[]; onDone: (v: VisitDto) => void; onCancel: () => void }) {
  const { t, err } = useI18n();
  const can = useCan();
  const members = useMembers();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({ mutationFn: (body: object) => api<VisitDto>('/crm/visits', { method: 'POST', body }), onSuccess: onDone });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = validate(visitSchema, {
      accountId: accountId ?? opt(fd, 'accountId'), opportunityId: opt(fd, 'opportunityId'), purpose: opt(fd, 'purpose'),
      scheduledStart: fromLocalInput(String(fd.get('start') ?? '')), scheduledEnd: fromLocalInput(String(fd.get('end') ?? '')),
      ...(can('team.member.read') && opt(fd, 'rep') ? { repMembershipId: opt(fd, 'rep') } : {}),
    });
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate(v.data);
  }
  const reps = members.data?.filter((x) => x.role === 'rep' || x.role === 'manager' || x.role === 'owner') ?? [];
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {m.error && <Alert tone="error">{err(m.error)}</Alert>}
      {!accountId && (
        <Field label={t('visits.account')} htmlFor="visit-account" error={errors.accountId && t(errors.accountId.key)}>
          <AccountPicker name="accountId" />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('visits.when')} htmlFor="visit-start" error={errors.scheduledStart && t(errors.scheduledStart.key)}>
          <Input id="visit-start" name="start" type="datetime-local" defaultValue={toLocalInput(isoDaysFromNow(1, 10))} />
        </Field>
        <Field label={t('visits.end')} htmlFor="visit-end" optional error={errors.scheduledEnd && t('form.invalid')}>
          <Input id="visit-end" name="end" type="datetime-local" />
        </Field>
        {can('team.member.read') && (
          <Field label={t('visits.rep')} htmlFor="visit-rep" optional>
            <Select id="visit-rep" name="rep" defaultValue="">
              <option value="">{t('accounts.owner')}</option>
              {reps.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
            </Select>
          </Field>
        )}
        {!!opportunities?.length && (
          <Field label={t('visits.opportunity')} htmlFor="visit-opp" optional>
            <Select id="visit-opp" name="opportunityId" defaultValue="">
              <option value="">—</option>
              {opportunities.filter((o) => o.stageCategory === 'open').map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <Field label={t('visits.purpose')} htmlFor="visit-purpose" optional>
        <Input id="visit-purpose" name="purpose" />
      </Field>
      <Actions onCancel={onCancel} pending={m.isPending} />
    </form>
  );
}

export function ContactForm({ accountId, contact, onDone, onCancel }: { accountId: string; contact?: ContactDto; onDone: () => void; onCancel: () => void }) {
  const { t, err } = useI18n();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({
    mutationFn: (body: object) =>
      contact ? api(`/crm/contacts/${contact.id}`, { method: 'PATCH', body }) : api(`/crm/accounts/${accountId}/contacts`, { method: 'POST', body }),
    onSuccess: onDone,
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = validate(contactSchema, {
      fullName: String(fd.get('fullName') ?? '').trim(), jobTitle: opt(fd, 'jobTitle'), phone: opt(fd, 'phone'), email: opt(fd, 'email'),
      preferredChannel: opt(fd, 'preferredChannel'), isPrimary: fd.get('isPrimary') === 'on',
    });
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate(v.data);
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {m.error && <Alert tone="error">{err(m.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('contacts.fullName')} htmlFor="ct-name" error={errors.fullName && t(errors.fullName.key, errors.fullName.vars)}>
          <Input id="ct-name" name="fullName" defaultValue={contact?.fullName} autoFocus />
        </Field>
        <Field label={t('contacts.jobTitle')} htmlFor="ct-title" optional>
          <Input id="ct-title" name="jobTitle" defaultValue={contact?.jobTitle ?? ''} />
        </Field>
        <Field label={t('contacts.phone')} htmlFor="ct-phone" optional>
          <Input id="ct-phone" name="phone" type="tel" dir="ltr" defaultValue={contact?.phone ?? ''} />
        </Field>
        <Field label={t('contacts.email')} htmlFor="ct-email" optional error={errors.email && t(errors.email.key)}>
          <Input id="ct-email" name="email" type="email" dir="ltr" defaultValue={contact?.email ?? ''} />
        </Field>
        <Field label={t('contacts.channel')} htmlFor="ct-channel" optional>
          <Select id="ct-channel" name="preferredChannel" defaultValue={contact?.preferredChannel ?? ''}>
            <option value="">—</option>
            {(['phone', 'whatsapp', 'email', 'visit'] as const).map((c) => <option key={c} value={c}>{t(`contacts.channel.${c}`)}</option>)}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="isPrimary" defaultChecked={contact?.isPrimary} className="size-5 accent-brand-600" />
          {t('contacts.primary')}
        </label>
      </div>
      <p className="text-xs text-ink-500">{t('contacts.encrypted')}</p>
      <Actions onCancel={onCancel} pending={m.isPending} />
    </form>
  );
}
