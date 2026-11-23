'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tenantSettingsSchema, type TenantDto } from '@rakan/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useToast } from '@/components/feedback';
import { Alert, Button, Card, CardHeading, ErrorState, Field, Input, LoadingState, NoPermission, PageHeader, Select } from '@/components/ui';
import { api, apiForm } from '@/lib/api';
import { validate, type FieldErrors } from '@/lib/forms';
import { useCan, useI18n } from '@/lib/providers';

const TIMEZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Africa/Cairo', 'UTC'];

export default function CompanySettingsPage() {
  const { t, err } = useI18n();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [errors, setErrors] = useState<FieldErrors>({});
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantDto>('/tenant'), enabled: can('tenant.settings.read') });
  const save = useMutation({
    mutationFn: (body: object) => api<TenantDto>('/tenant', { method: 'PATCH', body }),
    onSuccess: (data) => {
      qc.setQueryData(['tenant'], data);
      toast(t('common.saveSuccess'));
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (!can('tenant.settings.read')) return <NoPermission />;
  if (tenant.isLoading) return <LoadingState card />;
  if (tenant.error) return <ErrorState error={tenant.error} onRetry={() => tenant.refetch()} />;
  const d = tenant.data!;
  const editable = can('tenant.settings.update');
  const s = d.settings as { repVisibility?: string; recordingEnabled?: boolean; recordingRetentionDays?: number };

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
      settings: {
        repVisibility: String(fd.get('repVisibility')), recordingEnabled: fd.get('recordingEnabled') === 'on',
        recordingRetentionDays: Number(fd.get('recordingRetentionDays') || 90),
      },
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
            <p className="-mt-3 text-sm text-fg-muted sm:col-span-2">{t('company.recordingHint')}</p>
            <Field label={t('company.recordingRetention')} htmlFor="recordingRetentionDays" error={fe('settings.recordingRetentionDays')}>
              <Input id="recordingRetentionDays" name="recordingRetentionDays" type="number" min={7} max={365} dir="ltr" defaultValue={s.recordingRetentionDays ?? 90} />
            </Field>
          </fieldset>
          {editable && (
            <div className="flex justify-end">
              <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
            </div>
          )}
        </form>
      </Card>
      <LogoCard editable={editable} />
    </>
  );
}

function LogoCard({ editable }: { editable: boolean }) {
  const { t, err } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<{ name: string; settings: { logo?: { updatedAt: string } } }>('/tenant') });
  const logo = tenant.data?.settings?.logo;
  const done = (msg: string) => { void qc.invalidateQueries({ queryKey: ['tenant'] }); toast(msg); };
  const up = useMutation({
    mutationFn: (f: File) => { const fd = new FormData(); fd.set('file', f); return apiForm('/tenant/logo', fd); },
    onSuccess: () => done(t('logo.saved')),
  });
  const rm = useMutation({ mutationFn: () => api('/tenant/logo', { method: 'DELETE' }), onSuccess: () => done(t('logo.removed')) });
  return (
    <Card className="mt-5 p-5 sm:p-6">
      <CardHeading>{t('logo.title')}</CardHeading>
      <p className="mb-4 text-sm text-fg-muted">{t('logo.hint')}</p>
      {(up.error || rm.error) && <div className="mb-3"><Alert tone="error">{err(up.error ?? rm.error)}</Alert></div>}
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid h-20 w-40 place-items-center rounded-xl border border-line bg-white p-2">
          {logo ? <img src={`/api/tenant/logo?v=${encodeURIComponent(logo.updatedAt)}`} alt={t('logo.alt', { name: tenant.data?.name ?? '' })} className="max-h-16 max-w-36 object-contain" /> : <span className="text-xs text-fg-muted">{t('logo.none')}</span>}
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp" className="sr-only" aria-label={t('logo.upload')}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); e.target.value = ''; }} />
            <Button variant="secondary" icon="upload" loading={up.isPending} onClick={() => input.current?.click()}>{t('logo.upload')}</Button>
            {logo && <Button variant="ghost" loading={rm.isPending} onClick={() => rm.mutate()}>{t('logo.remove')}</Button>}
          </div>
        )}
      </div>
    </Card>
  );
}
