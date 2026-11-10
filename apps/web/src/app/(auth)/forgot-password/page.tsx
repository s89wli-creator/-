'use client';

import { useMutation } from '@tanstack/react-query';
import { forgotPasswordSchema } from '@rakan/shared';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { formObject, validate, type FieldErrors } from '@/lib/forms';
import { useI18n } from '@/lib/providers';

export default function ForgotPasswordPage() {
  const { t, err, locale } = useI18n();
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({ mutationFn: (body: unknown) => api('/auth/password/forgot', { method: 'POST', body }) });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = validate(forgotPasswordSchema, formObject(e.currentTarget));
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate({ ...v.data, locale });
  }

  return (
    <>
      <h1 className="text-xl font-semibold">{t('auth.forgot.title')}</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">{t('auth.forgot.subtitle')}</p>
      {m.isSuccess ? (
        <Alert tone="success">{t('auth.forgot.sent')}</Alert>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {m.error && <Alert tone="error">{err(m.error)}</Alert>}
          <Field label={t('common.email')} htmlFor="email" error={errors.email && t(errors.email.key)}>
            <Input id="email" name="email" type="email" autoComplete="email" dir="ltr" aria-invalid={!!errors.email} />
          </Field>
          <Button type="submit" className="w-full" loading={m.isPending}>{t('auth.forgot.submit')}</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-brand-700 hover:underline">{t('auth.backToLogin')}</Link>
      </p>
    </>
  );
}
