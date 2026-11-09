'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { passwordSchema, type SystemRole } from '@rakan/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Alert, Button, ErrorState, Field, Input, LoadingState } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formObject, validate, type FieldErrors } from '@/lib/forms';
import { useI18n, useMe } from '@/lib/providers';

interface Preview {
  tenantName: string;
  email: string;
  role: SystemRole;
  status: 'pending' | 'expired' | 'used';
  accountExists: boolean;
}

const newAccountSchema = z.object({ fullName: z.string().trim().min(2).max(120), password: passwordSchema });

export default function InvitePage() {
  const { t, err } = useI18n();
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const [errors, setErrors] = useState<FieldErrors>({});
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<Preview>(`/invitations/${encodeURIComponent(token)}`),
  });
  const accept = useMutation({
    mutationFn: (body: object) => api('/invitations/accept', { method: 'POST', body: { token: decodeURIComponent(token), ...body } }),
    onSuccess: async () => {
      qc.clear();
      router.replace('/home');
    },
  });

  if (preview.isLoading || me.isLoading) return <LoadingState />;
  if (preview.error) {
    return preview.error instanceof ApiError && preview.error.status === 404 ? (
      <Alert tone="error">{t('invite.notFound')}</Alert>
    ) : (
      <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
    );
  }
  const p = preview.data!;
  const signedInAsInvitee = me.data?.user.email === p.email;

  function submitNew(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = validate(newAccountSchema, formObject(e.currentTarget));
    setErrors(v.ok ? {} : v.errors);
    if (v.ok) accept.mutate(v.data);
  }

  return (
    <>
      <h1 className="text-xl font-semibold">{t('invite.title')}</h1>
      <p className="mb-6 mt-2 text-sm text-ink-700">
        {t('invite.body', { company: p.tenantName, role: t(`role.${p.role}`) })}
      </p>
      {p.status === 'expired' && <Alert tone="error">{t('invite.expired')}</Alert>}
      {p.status === 'used' && <Alert tone="info">{t('invite.used')}</Alert>}
      {p.status === 'pending' && (
        <div className="space-y-4">
          {accept.error && <Alert tone="error">{err(accept.error)}</Alert>}
          {p.accountExists ? (
            signedInAsInvitee ? (
              <Button className="w-full" loading={accept.isPending} onClick={() => accept.mutate({})}>
                {t('invite.accept')}
              </Button>
            ) : (
              <>
                <Alert tone="info">{t('invite.loginFirst')}</Alert>
                <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">
                  {t('auth.login.title')}
                </Link>
              </>
            )
          ) : (
            <form onSubmit={submitNew} noValidate className="space-y-4">
              <p className="text-sm font-medium">{t('invite.createAccount')}</p>
              <Field label={t('common.email')} htmlFor="email">
                <Input id="email" value={p.email} readOnly dir="ltr" className="bg-ink-50" />
              </Field>
              <Field label={t('common.fullName')} htmlFor="fullName" error={errors.fullName && t(errors.fullName.key, errors.fullName.vars)}>
                <Input id="fullName" name="fullName" autoComplete="name" aria-invalid={!!errors.fullName} />
              </Field>
              <Field
                label={t('common.password')}
                htmlFor="password"
                hint={t('auth.password.hint')}
                error={errors.password && t(errors.password.key, errors.password.vars)}
              >
                <Input id="password" name="password" type="password" autoComplete="new-password" dir="ltr" aria-invalid={!!errors.password} />
              </Field>
              <Button type="submit" className="w-full" loading={accept.isPending}>{t('invite.accept')}</Button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
