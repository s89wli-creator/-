'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { registerSchema } from '@rakan/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { formObject, validate, type FieldErrors } from '@/lib/forms';
import { useI18n } from '@/lib/providers';

export default function RegisterPage() {
  const { t, err, locale } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({
    mutationFn: (body: unknown) => api('/auth/register', { method: 'POST', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/home');
    },
  });
  const fe = (k: string) => (errors[k] ? t(errors[k]!.key, errors[k]!.vars) : undefined);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = validate(registerSchema, { ...formObject(e.currentTarget), locale });
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate(v.data);
  }

  return (
    <>
      <h1 className="text-xl font-semibold">{t('auth.register.title')}</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">{t('auth.register.subtitle')}</p>
      <form onSubmit={submit} noValidate className="space-y-4">
        {m.error && <Alert tone="error">{err(m.error)}</Alert>}
        <Field label={t('auth.register.company')} htmlFor="companyName" error={fe('companyName')}>
          <Input id="companyName" name="companyName" autoComplete="organization" aria-invalid={!!errors.companyName} />
        </Field>
        <Field label={t('common.fullName')} htmlFor="fullName" error={fe('fullName')}>
          <Input id="fullName" name="fullName" autoComplete="name" aria-invalid={!!errors.fullName} />
        </Field>
        <Field label={t('common.email')} htmlFor="email" error={fe('email')}>
          <Input id="email" name="email" type="email" autoComplete="email" dir="ltr" aria-invalid={!!errors.email} />
        </Field>
        <Field label={t('common.password')} htmlFor="password" hint={t('auth.password.hint')} error={fe('password')}>
          <Input id="password" name="password" type="password" autoComplete="new-password" dir="ltr" aria-invalid={!!errors.password} />
        </Field>
        <Button type="submit" className="w-full" loading={m.isPending}>{t('auth.register.submit')}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-fg-muted">
        {t('auth.register.haveAccount')}{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">{t('auth.login.title')}</Link>
      </p>
    </>
  );
}
