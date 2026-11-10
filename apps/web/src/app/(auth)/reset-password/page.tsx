'use client';

import { useMutation } from '@tanstack/react-query';
import { passwordSchema } from '@rakan/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Alert, Button, Field, Input, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { formObject, validate, type FieldErrors } from '@/lib/forms';
import { useI18n } from '@/lib/providers';

function ResetForm() {
  const { t, err } = useI18n();
  const token = useSearchParams().get('token');
  const [errors, setErrors] = useState<FieldErrors>({});
  const m = useMutation({ mutationFn: (body: unknown) => api('/auth/password/reset', { method: 'POST', body }) });

  if (!token) return <Alert tone="error">{t('auth.reset.missingToken')}</Alert>;
  if (m.isSuccess) return <Alert tone="success">{t('auth.reset.done')}</Alert>;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = validate(z.object({ password: passwordSchema }), formObject(e.currentTarget));
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) m.mutate({ token, password: v.data.password });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {m.error && <Alert tone="error">{err(m.error)}</Alert>}
      <Field
        label={t('common.password')}
        htmlFor="password"
        hint={t('auth.password.hint')}
        error={errors.password && t(errors.password.key, errors.password.vars)}
      >
        <Input id="password" name="password" type="password" autoComplete="new-password" dir="ltr" aria-invalid={!!errors.password} />
      </Field>
      <Button type="submit" className="w-full" loading={m.isPending}>{t('auth.reset.submit')}</Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  const { t } = useI18n();
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">{t('auth.reset.title')}</h1>
      <Suspense fallback={<LoadingState rows={2} />}>
        <ResetForm />
      </Suspense>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-brand-700 hover:underline">{t('auth.backToLogin')}</Link>
      </p>
    </>
  );
}
