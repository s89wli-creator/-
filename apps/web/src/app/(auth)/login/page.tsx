'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { loginSchema } from '@rakan/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { formObject, validate, type FieldErrors } from '@/lib/forms';
import { useI18n } from '@/lib/providers';

export default function LoginPage() {
  const { t, err } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({
    mutationFn: (body: unknown) => api('/auth/login', { method: 'POST', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/home');
    },
  });
  const fe = (k: string) => (errors[k] ? t(errors[k]!.key, errors[k]!.vars) : undefined);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = validate(loginSchema, formObject(e.currentTarget));
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate(v.data);
  }

  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">{t('auth.login.title')}</h1>
      <form onSubmit={submit} noValidate className="space-y-4">
        {m.error && <Alert tone="error">{err(m.error)}</Alert>}
        <Field label={t('common.email')} htmlFor="email" error={fe('email')}>
          <Input id="email" name="email" type="email" autoComplete="email" dir="ltr" required aria-invalid={!!errors.email} />
        </Field>
        <Field label={t('common.password')} htmlFor="password" error={fe('password')}>
          <Input id="password" name="password" type="password" autoComplete="current-password" dir="ltr" required aria-invalid={!!errors.password} />
        </Field>
        <div className="text-end">
          <Link href="/forgot-password" className="text-sm text-brand-700 hover:underline">{t('auth.login.forgot')}</Link>
        </div>
        <Button type="submit" className="w-full" loading={m.isPending}>{t('auth.login.submit')}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">
        {t('auth.login.noAccount')}{' '}
        <Link href="/register" className="font-medium text-brand-700 hover:underline">{t('auth.login.createCompany')}</Link>
      </p>
    </>
  );
}
