'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tenantSettingsSchema, type TenantDto } from '@rakan/shared';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, ErrorState, Field, Input, LoadingState, NoPermission, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { validate, type FieldErrors } from '@/lib/forms';
import { useCan, useI18n } from '@/lib/providers';

const TIMEZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Africa/Cairo', 'UTC'];

export default function CompanySettingsPage() {
  const { t, err } = useI18n();
  const can = useCan();
  const qc = useQueryClient();
  const [errors, setErrors] = useState<FieldErrors>({});
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantDto>('/tenant'), enabled: can('tenant.settings.read') });
  const save = useMutation({
    mutationFn: (body: object) => api<TenantDto>('/tenant', { method: 'PATCH', body }),
    onSuccess: (data) => {
      qc.setQueryData(['tenant'], data);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (!can('tenant.settings.read')) return <NoPermission />;
  if (tenant.isLoading) return <LoadingState />;
  if (tenant.error) return <ErrorState error={tenant.error} onRetry={() => tenant.refetch()} />;
  const d = tenant.data!;
  const editable = can('tenant.settings.update');
  const s = d.settings as { repVisibility?: string; recordingEnabled?: boolean };

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const opt = (k: string) => {
      const v = String(fd.get(k) ?? '').trim();
      return v === '' ? null : v;
    };
    const input = {
      name: String(fd.get('name') ?? ''),
      legalName: opt('legalName'),
      crNumber: opt('crNumber'),
      vatNumber: opt('vatNumber'),
      industry: opt('industry'),
      timezone: String(fd.get('timezone')),
      defaultLocale: String(fd.get('defaultLocale')),
      settings: { repVisibility: String(fd.get('repVisibility')), recordingEnabled: fd.get('recordingEnabled') === 'on' },
    };
    const v = validate(tenantSettingsSchema, input);
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) save.mutate(v.data);
  }

  const fe = (k: string) => (errors[k] ? t(errors[k]!.key, errors[k]!.vars) : undefined);

  return (
    <>
      <PageHeader title={t('company.title')} />
      <Card className="p-5 sm:p-6">
        <form onSubmit={submit} noValidate className="space-y-5">
          {!editable && <Alert tone="info">{t('company.readOnly')}</Alert>}
          {save.error && <Alert tone="error">{err(save.error)}</Alert>}
          {save.isSuccess && <Alert tone="success">{t('common.saved')}</Alert>}
          <fieldset disabled={!editable || save.isPending} className="grid gap-5 sm:grid-cols-2">
            <Field label={t('company.name')} htmlFor="name" error={fe('name')}>
              <Input id="name" name="name" defaultValue={d.name} aria-invalid={!!errors.name} />
            </Field>
            <Field label={t('company.legalName')} htmlFor="legalName" optional>
              <Input id="legalName" name="legalName" defaultValue={d.legalName ?? ''} />
            </Field>
            <Field label={t('company.cr')} htmlFor="crNumber" optional error={fe('crNumber')}>
              <Input id="crNumber" name="crNumber" inputMode="numeric" dir="ltr" defaultValue={d.crNumber ?? ''} aria-invalid={!!errors.crNumber} />
            </Field>
            <Field label={t('company.vat')} htmlFor="vatNumber" optional error={fe('vatNumber')}>
              <Input id="vatNumber" name="vatNumber" inputMode="numeric" dir="ltr" defaultValue={d.vatNumber ?? ''} aria-invalid={!!errors.vatNumber} />
            </Field>
            <Field label={t('company.industry')} htmlFor="industry" optional>
              <Input id="industry" name="industry" defaultValue={d.industry ?? ''} />
            </Field>
            <Field label={t('company.timezone')} htmlFor="timezone">
              <Select id="timezone" name="timezone" defaultValue={d.timezone} dir="ltr">
                {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
            <Field label={t('company.locale')} htmlFor="defaultLocale">
              <Select id="defaultLocale" name="defaultLocale" defaultValue={d.defaultLocale}>
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label={t('company.repVisibility')} htmlFor="repVisibility">
              <Select id="repVisibility" name="repVisibility" defaultValue={s.repVisibility ?? 'assigned_only'}>
                <option value="assigned_only">{t('company.repVisibility.assigned_only')}</option>
                <option value="all">{t('company.repVisibility.all')}</option>
              </Select>
            </Field>
            <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2">
              <input type="checkbox" name="recordingEnabled" defaultChecked={!!s.recordingEnabled} className="size-5 accent-brand-600" />
              {t('company.recording')}
            </label>
          </fieldset>
          {editable && (
            <div className="flex justify-end">
              <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
            </div>
          )}
        </form>
      </Card>
    </>
  );
}
