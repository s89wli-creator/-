'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { Alert, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

function Verify() {
  const { t, err } = useI18n();
  const token = useSearchParams().get('token');
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api('/auth/email/verify', { method: 'POST', body: { token } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const started = useRef(false);
  useEffect(() => {
    // Verify once on load (a token is single-use; StrictMode would otherwise call twice).
    if (token && !started.current) {
      started.current = true;
      m.mutate();
    }
  }, [token, m]);

  if (!token) return <Alert tone="error">{t('errors.INVALID_TOKEN')}</Alert>;
  if (m.error) return <Alert tone="error">{err(m.error)}</Alert>;
  if (m.isSuccess) return <Alert tone="success">{t('auth.verify.done')}</Alert>;
  return <p className="text-fg-muted" role="status">{t('auth.verify.working')}</p>;
}

export default function VerifyEmailPage() {
  const { t } = useI18n();
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">{t('auth.verify.title')}</h1>
      <Suspense fallback={<LoadingState rows={1} />}>
        <Verify />
      </Suspense>
      <p className="mt-6 text-center text-sm">
        <Link href="/home" className="text-brand-700 hover:underline">{t('auth.verify.continue')}</Link>
      </p>
    </>
  );
}
