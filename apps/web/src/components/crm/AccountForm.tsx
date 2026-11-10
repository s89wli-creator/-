'use client';

import { useMutation } from '@tanstack/react-query';
import { SAUDI_REGIONS, accountSchema, type AccountDto, type CustomFieldDto } from '@rakan/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useCrmSettings, useMembers } from '@/lib/crm';
import { validate, type FieldErrors } from '@/lib/forms';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

export function CustomFieldInputs({ defs, values, trackId }: { defs: CustomFieldDto[]; values: Record<string, unknown>; trackId: string | null }) {
  const { t } = useI18n();
  const visible = defs.filter((d) => !d.trackId || d.trackId === trackId);
  if (!visible.length) return null;
  return (
    <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium text-fg-sub">{t('accounts.customFields')}</legend>
      {visible.map((d) => {
        const id = `cf-${d.key}`;
        const v = values[d.key];
        return (
          <Field key={d.id} label={d.label} htmlFor={id} optional>
            {d.type === 'select' ? (
              <Select id={id} name={`cf.${d.key}`} defaultValue={v === undefined ? '' : String(v)}>
                <option value="">—</option>
                {d.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            ) : d.type === 'boolean' ? (
              <Select id={id} name={`cf.${d.key}`} defaultValue={v === undefined ? '' : String(v)}>
                <option value="">—</option>
                <option value="true">{t('common.yes')}</option>
                <option value="false">{t('common.no')}</option>
              </Select>
            ) : (
              <Input id={id} name={`cf.${d.key}`} type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'text'} defaultValue={v === undefined ? '' : String(v)} />
            )}
          </Field>
        );
      })}
    </fieldset>
  );
}

export function readCustomFields(fd: FormData, defs: CustomFieldDto[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const raw = fd.get(`cf.${d.key}`);
    if (raw === null) continue;
    const s = String(raw).trim();
    out[d.key] = s === '' ? null : d.type === 'number' ? Number(s) : d.type === 'boolean' ? s === 'true' : s;
  }
  return out;
}

/** Create or edit an account. On create, a 409 duplicate offers "open existing" or "create anyway". */
export function AccountForm({ account, onSaved, onCancel }: { account?: AccountDto; onSaved: (a: AccountDto) => void; onCancel: () => void }) {
  const { t, err } = useI18n();
  const can = useCan();
  const settings = useCrmSettings();
  const members = useMembers();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [trackId, setTrackId] = useState<string | null>(account?.trackId ?? null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      account ? api<AccountDto>(`/crm/accounts/${account.id}`, { method: 'PATCH', body }) : api<AccountDto>('/crm/accounts', { method: 'POST', body }),
    onSuccess: onSaved,
  });
  const dup = save.error instanceof ApiError && save.error.code === 'DUPLICATE_ACCOUNT' ? (save.error.details as unknown as { id: string; name: string; reason: string }) : null;
  const canAssign = can('team.member.read');
  const defs = (settings.data?.customFields ?? []).filter((f) => f.entity === 'account');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const opt = (k: string) => {
      const v = String(fd.get(k) ?? '').trim();
      return v === '' ? null : v;
    };
    const input: Record<string, unknown> = {
      name: String(fd.get('name') ?? '').trim(),
      legalName: opt('legalName'), crNumber: opt('crNumber'), vatNumber: opt('vatNumber'), website: opt('website'), phone: opt('phone'),
      industry: opt('industry'), region: opt('region'), city: opt('city'), address: opt('address'), trackId: opt('trackId'),
      customFields: readCustomFields(fd, defs),
    };
    if (canAssign) input.ownerMembershipId = opt('ownerMembershipId');
    if (account) input.status = String(fd.get('status'));
    const v = validate(account ? accountSchema.partial() : accountSchema, input);
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    setPending(v.data);
    save.mutate(v.data);
  }

  const fe = (k: string) => (errors[k] ? t(errors[k]!.key, errors[k]!.vars) : save.error instanceof ApiError ? save.error.fieldError(k) && t('form.invalid') : undefined);

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {dup ? (
        <Alert tone="info">
          <p className="font-medium">{t('accounts.duplicateTitle')}</p>
          <p className="mt-1">{t('accounts.duplicateBody', { name: dup.name, reason: t(`accounts.dupReason.${dup.reason}` as MessageKey) })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/accounts/${dup.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-on-brand">
              {t('accounts.duplicateOpen')}
            </Link>
            <Button type="button" variant="secondary" onClick={() => pending && save.mutate({ ...pending, force: true })}>{t('accounts.duplicateForce')}</Button>
          </div>
        </Alert>
      ) : (
        save.error && <Alert tone="error">{err(save.error)}</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label={t('accounts.name')} htmlFor="acc-name" error={fe('name')}>
            <Input id="acc-name" name="name" defaultValue={account?.name} autoFocus aria-invalid={!!errors.name} />
          </Field>
        </div>
        <Field label={t('accounts.cr')} htmlFor="acc-cr" optional error={fe('crNumber')}>
          <Input id="acc-cr" name="crNumber" inputMode="numeric" dir="ltr" defaultValue={account?.crNumber ?? ''} />
        </Field>
        <Field label={t('accounts.phone')} htmlFor="acc-phone" optional error={fe('phone')}>
          <Input id="acc-phone" name="phone" type="tel" dir="ltr" defaultValue={account?.phone ?? ''} />
        </Field>
        <Field label={t('accounts.city')} htmlFor="acc-city" optional>
          <Input id="acc-city" name="city" defaultValue={account?.city ?? ''} />
        </Field>
        <Field label={t('accounts.region')} htmlFor="acc-region" optional>
          <Select id="acc-region" name="region" defaultValue={account?.region ?? ''}>
            <option value="">—</option>
            {SAUDI_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <Field label={t('accounts.industry')} htmlFor="acc-industry" optional>
          <Input id="acc-industry" name="industry" defaultValue={account?.industry ?? ''} />
        </Field>
        {!!settings.data?.tracks.length && (
          <Field label={t('accounts.track')} htmlFor="acc-track" optional>
            <Select id="acc-track" name="trackId" value={trackId ?? ''} onChange={(e) => setTrackId(e.target.value || null)}>
              <option value="">—</option>
              {settings.data.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
            </Select>
          </Field>
        )}
        {canAssign && (
          <Field label={t('accounts.owner')} htmlFor="acc-owner" optional>
            <Select id="acc-owner" name="ownerMembershipId" defaultValue={account?.ownerMembershipId ?? ''}>
              <option value="">{t('common.unassigned')}</option>
              {members.data?.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('accounts.website')} htmlFor="acc-web" optional error={fe('website')}>
          <Input id="acc-web" name="website" dir="ltr" defaultValue={account?.websiteDomain ?? ''} />
        </Field>
        <Field label={t('accounts.vat')} htmlFor="acc-vat" optional error={fe('vatNumber')}>
          <Input id="acc-vat" name="vatNumber" inputMode="numeric" dir="ltr" defaultValue={account?.vatNumber ?? ''} />
        </Field>
        <Field label={t('accounts.legalName')} htmlFor="acc-legal" optional>
          <Input id="acc-legal" name="legalName" defaultValue={account?.legalName ?? ''} />
        </Field>
        {account && (
          <Field label={t('accounts.status')} htmlFor="acc-status">
            <Select id="acc-status" name="status" defaultValue={account.status}>
              {(['active', 'customer', 'disqualified', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`accounts.status.${s}`)}</option>)}
            </Select>
          </Field>
        )}
        <div className="sm:col-span-2">
          <Field label={t('accounts.address')} htmlFor="acc-address" optional>
            <Input id="acc-address" name="address" defaultValue={account?.address ?? ''} />
          </Field>
        </div>
        <CustomFieldInputs defs={defs} values={account?.customFields ?? {}} trackId={trackId} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}
