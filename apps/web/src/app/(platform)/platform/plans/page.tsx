'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanDto } from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import { useToast } from '@/components/feedback';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, LoadingState, Modal, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/lib/providers';

const LIMITS = ['users', 'aiMonthlyUsd', 'storageMb', 'recordingMinutes'] as const;
const num = (v: FormDataEntryValue | null) => (String(v ?? '').trim() === '' ? null : Number(v));

/** Plans are data: prices and limits change here, without a release. Empty limit = unlimited. */
export default function PlatformPlansPage() {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PlanDto | 'new' | null>(null);
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<PlanDto[]>('/platform/plans') });
  const save = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: object }) =>
      id ? api<PlanDto[]>(`/platform/plans/${id}`, { method: 'PATCH', body }) : api<PlanDto[]>('/platform/plans', { method: 'POST', body }),
    onSuccess: (list) => {
      qc.setQueryData(['platform-plans'], list);
      setEditing(null);
      toast(t('common.saveSuccess'));
    },
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = {
      ...(editing === 'new' ? { key: String(fd.get('key') ?? '') } : {}),
      nameAr: String(fd.get('nameAr') ?? ''), nameEn: String(fd.get('nameEn') ?? ''),
      priceSarMonthly: num(fd.get('price')), sort: Number(fd.get('sort') || 0), isActive: fd.get('isActive') === 'on',
      limits: Object.fromEntries(LIMITS.map((k) => [k, num(fd.get(k))])),
    };
    save.mutate({ id: editing !== 'new' && editing ? editing.id : undefined, body });
  }

  if (plans.isLoading) return <LoadingState card rows={4} />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={() => plans.refetch()} />;
  const p = editing !== 'new' ? editing : null;

  return (
    <>
      <PageHeader title={t('platform.plans.title')} subtitle={t('platform.plans.subtitle')} actions={<Button icon="plus" onClick={() => { save.reset(); setEditing('new'); }}>{t('platform.plans.add')}</Button>} />
      <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {plans.data!.map((x) => (
          <Card key={x.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold">{locale === 'ar' ? x.nameAr : x.nameEn}</h2>
              {!x.isActive && <Badge tone="muted">{t('platform.plans.inactive')}</Badge>}
            </div>
            <p className="mt-1 font-display text-2xl font-semibold text-heading">
              {x.priceSarMonthly === null ? t('platform.plans.custom') : `${x.priceSarMonthly} ${t('platform.sarMonth')}`}
            </p>
            <dl className="mt-4 flex-1 space-y-1.5 text-sm">
              {LIMITS.map((k) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-fg-muted">{t(`platform.limit.${k}` as MessageKey)}</dt>
                  <dd className="tabular-nums font-medium">{x.limits[k] === null ? t('platform.unlimited') : x.limits[k]}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex items-center justify-between border-t border-line-soft pt-3 text-sm">
              <span className="text-fg-muted">{t('platform.tenantsCount', { n: x.tenants })}</span>
              <Button variant="ghost" className="min-h-9" onClick={() => { save.reset(); setEditing(x); }}>{t('common.edit')}</Button>
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-fg-muted">{t('platform.plans.note')}</p>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? t('platform.plans.add') : t('common.edit')} size="lg">
        {editing && (
          <form key={p?.id ?? 'new'} onSubmit={submit} className="space-y-4">
            {save.error && <Alert tone="error">{err(save.error)}</Alert>}
            {editing === 'new' && (
              <Field label={t('platform.plans.key')} htmlFor="key"><Input id="key" name="key" dir="ltr" required pattern="[a-z][a-z0-9_-]{1,30}" /></Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('platform.plans.nameAr')} htmlFor="nameAr"><Input id="nameAr" name="nameAr" required defaultValue={p?.nameAr ?? ''} /></Field>
              <Field label={t('platform.plans.nameEn')} htmlFor="nameEn"><Input id="nameEn" name="nameEn" dir="ltr" required defaultValue={p?.nameEn ?? ''} /></Field>
              <Field label={t('platform.plans.price')} htmlFor="price" optional><Input id="price" name="price" type="number" min={0} step="any" dir="ltr" defaultValue={p?.priceSarMonthly ?? ''} /></Field>
              <Field label={t('platform.plans.sort')} htmlFor="sort"><Input id="sort" name="sort" type="number" min={0} dir="ltr" defaultValue={p?.sort ?? 10} /></Field>
              {LIMITS.map((k) => (
                <Field key={k} label={t(`platform.limit.${k}` as MessageKey)} htmlFor={`l-${k}`} optional>
                  <Input id={`l-${k}`} name={k} type="number" min={0} dir="ltr" defaultValue={p ? (p.limits[k] ?? '') : ''} placeholder={t('platform.unlimited')} />
                </Field>
              ))}
            </div>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={p?.isActive ?? true} className="size-5 accent-brand-600" /> {t('platform.plans.active')}
            </label>
            <Button type="submit" className="w-full" loading={save.isPending}>{t('common.save')}</Button>
          </form>
        )}
      </Modal>
    </>
  );
}
