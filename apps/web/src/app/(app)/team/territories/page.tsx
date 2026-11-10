'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { SAUDI_REGIONS, territorySchema, type MemberDto, type TerritoryDto } from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import {
  Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, NoPermission, PageHeader,
} from '@/components/ui';
import { useConfirm, useToast } from '@/components/feedback';
import { api } from '@/lib/api';
import { validate, type FieldErrors } from '@/lib/forms';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

type Editing = { mode: 'create' } | { mode: 'edit'; territory: TerritoryDto };

export default function TerritoriesPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { t, err } = useI18n();
  const can = useCan();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const list = useQuery({ queryKey: ['territories'], queryFn: () => api<TerritoryDto[]>('/team/territories'), enabled: can('team.territory.read') });
  // Member names are shown only to roles that can read the team.
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<MemberDto[]>('/team/members'), enabled: can('team.member.read') });

  const save = useMutation({
    mutationFn: async ({ id, body, memberIds }: { id?: string; body: object; memberIds?: string[] }) => {
      const tr = id
        ? await api<TerritoryDto>(`/team/territories/${id}`, { method: 'PATCH', body })
        : await api<TerritoryDto>('/team/territories', { method: 'POST', body });
      // Only replace assignments when the member picker was shown; otherwise keep them untouched.
      if (!memberIds) return tr;
      return api<TerritoryDto>(`/team/territories/${tr.id}/members`, { method: 'PUT', body: { membershipIds: memberIds } });
    },
    onSuccess: () => {
      setEditing(null);
      toast(t('common.saveSuccess'));
      invalidate('territories');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/team/territories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(t('common.deleted'));
      invalidate('territories');
    },
  });

  if (!can('team.territory.read')) return <NoPermission />;
  const manage = can('team.territory.manage');
  const memberName = (id: string) => members.data?.find((m) => m.id === id)?.fullName;

  const current = editing?.mode === 'edit' ? editing.territory : undefined;
  const showMemberPicker = can('team.member.read') && members.isSuccess;
  // Active reps/managers, plus anyone already assigned (so saving never silently drops them).
  const assignableMembers = (members.data ?? []).filter(
    (m) => (m.status === 'active' && (m.role === 'rep' || m.role === 'manager')) || current?.memberIds.includes(m.id),
  );

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = {
      name: String(fd.get('name') ?? ''),
      regions: fd.getAll('regions').map(String),
      cities: String(fd.get('cities') ?? '').split(/[,،]/).map((c) => c.trim()).filter(Boolean),
    };
    const v = validate(territorySchema, input);
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    save.mutate({
      id: editing?.mode === 'edit' ? editing.territory.id : undefined,
      body: v.data,
      memberIds: showMemberPicker ? fd.getAll('members').map(String) : undefined,
    });
  }


  return (
    <>
      <PageHeader
        title={t('territories.title')}
        subtitle={t('territories.subtitle')}
        actions={manage && <Button onClick={() => { save.reset(); setErrors({}); setEditing({ mode: 'create' }); }}>{t('territories.new')}</Button>}
      />
      {remove.error && <div className="mb-4"><Alert tone="error">{err(remove.error)}</Alert></div>}
      {list.isLoading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data!.length === 0 ? (
        <Card><EmptyState icon="map">{t('territories.empty')}</EmptyState></Card>
      ) : (
        <div className="stagger grid gap-4 md:grid-cols-2">
          {list.data!.map((tr) => (
            <Card key={tr.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{tr.name}</h2>
                {manage && (
                  <div className="flex gap-1">
                    <Button variant="ghost" className="min-h-9 px-3" onClick={() => { save.reset(); setErrors({}); setEditing({ mode: 'edit', territory: tr }); }}>
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-9 px-3 text-danger"
                      onClick={() => void confirm({ title: t('territories.confirmDelete', { name: tr.name }), tone: 'danger', confirmLabel: t('common.delete') }).then((ok) => ok && remove.mutate(tr.id))}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                )}
              </div>
              {tr.regions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">{tr.regions.map((r) => <Badge key={r}>{r}</Badge>)}</div>
              )}
              {tr.cities.length > 0 && <p className="mt-2 text-sm text-fg-muted">{tr.cities.join('، ')}</p>}
              {can('team.member.read') && (
                <p className="mt-3 border-t border-line-soft pt-3 text-sm text-fg-sub">
                  <span className="text-fg-muted">{t('territories.members')}: </span>
                  {tr.memberIds.length ? tr.memberIds.map((id) => memberName(id) ?? '—').join('، ') : '—'}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={current ? current.name : t('territories.new')}>
        <form onSubmit={submit} noValidate className="space-y-4">
          {save.error && <Alert tone="error">{err(save.error)}</Alert>}
          <Field label={t('territories.name')} htmlFor="tr-name" error={errors.name && t(errors.name.key, errors.name.vars)}>
            <Input id="tr-name" name="name" defaultValue={current?.name} autoFocus aria-invalid={!!errors.name} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-fg-sub">{t('territories.regions')}</legend>
            <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto rounded-lg border border-line p-3">
              {SAUDI_REGIONS.map((r) => (
                <label key={r} className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="regions" value={r} defaultChecked={current?.regions.includes(r)} className="size-4 accent-brand-600" />
                  {r}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label={t('territories.cities')} htmlFor="tr-cities" optional>
            <Input id="tr-cities" name="cities" defaultValue={current?.cities.join('، ')} />
          </Field>
          {showMemberPicker && assignableMembers.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-fg-sub">{t('territories.members')}</legend>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-3">
                {assignableMembers.map((m) => (
                  <label key={m.id} className="flex min-h-9 items-center gap-2 text-sm">
                    <input type="checkbox" name="members" value={m.id} defaultChecked={current?.memberIds.includes(m.id)} className="size-4 accent-brand-600" />
                    {m.fullName}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
