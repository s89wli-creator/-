'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicProposalDto } from '@rakan/shared';
import { use, useState, type FormEvent } from 'react';
import { ProposalDocument } from '@/components/proposals/ProposalDocument';
import { Alert, Button, Field, Input, LoadingState, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/providers';

/** The customer's page: the approved proposal, and accept / decline with their name. No sign-in. */
export default function PublicProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { t, err } = useI18n();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<'accept' | 'decline' | null>(null);
  const q = useQuery({ queryKey: ['public-proposal', token], queryFn: () => api<PublicProposalDto>(`/public/proposals/${encodeURIComponent(token)}`), retry: false });
  const decide = useMutation({
    mutationFn: (body: { decision: 'accept' | 'decline'; name: string; note?: string }) =>
      api<PublicProposalDto>(`/public/proposals/${encodeURIComponent(token)}/decision`, { method: 'POST', body }),
    onSuccess: (d) => {
      qc.setQueryData(['public-proposal', token], d);
      setChoice(null);
    },
  });

  if (q.isLoading) return <div className="mx-auto max-w-3xl p-6"><LoadingState card /></div>;
  if (q.error) {
    return (
      <main className="mx-auto max-w-lg p-6 pt-24 text-center">
        <Alert tone="error">{q.error instanceof ApiError && q.error.status === 404 ? t('public.notFound') : err(q.error)}</Alert>
      </main>
    );
  }
  const p = q.data!;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    decide.mutate({ decision: choice!, name: String(fd.get('name') ?? '').trim(), note: String(fd.get('note') ?? '').trim() || undefined });
  }

  return (
    <main className="min-h-dvh bg-subtle py-6 print:bg-white">
      <div className="mx-auto max-w-3xl space-y-4 px-4">
        <div className="overflow-hidden rounded-2xl border border-line shadow-sm print:border-0 print:shadow-none">
          <ProposalDocument doc={p} />
        </div>

        <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6 print:hidden" aria-live="polite">
          {p.status === 'accepted' && <Alert tone="success">{t('public.accepted', { name: p.decisionByName ?? '', company: p.companyName })}</Alert>}
          {p.status === 'declined' && <Alert tone="info">{t('public.declined', { name: p.decisionByName ?? '' })}</Alert>}
          {p.status === 'cancelled' && <Alert tone="warn">{t('public.cancelled')}</Alert>}
          {p.status === 'sent' && p.expired && <Alert tone="warn">{t('public.expired', { company: p.companyName })}</Alert>}
          {p.status === 'sent' && !p.expired && (
            choice ? (
              <form onSubmit={submit} className="space-y-4">
                {decide.error && <Alert tone="error">{err(decide.error)}</Alert>}
                <Field label={t('public.yourName')} htmlFor="name"><Input id="name" name="name" required minLength={2} maxLength={120} autoComplete="name" /></Field>
                <Field label={t('public.note')} htmlFor="note" optional><Textarea id="note" name="note" rows={2} maxLength={1000} /></Field>
                {choice === 'accept' && <p className="text-xs text-fg-muted">{t('public.legal')}</p>}
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button type="button" variant="ghost" onClick={() => setChoice(null)}>{t('common.cancel')}</Button>
                  <Button type="submit" variant={choice === 'accept' ? 'primary' : 'danger'} loading={decide.isPending}>
                    {t(choice === 'accept' ? 'public.confirmAccept' : 'public.confirmDecline')}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={() => setChoice('decline')}>{t('public.decline')}</Button>
                <Button icon="check" onClick={() => setChoice('accept')}>{t('public.accept')}</Button>
              </div>
            )
          )}
        </section>
      </div>
    </main>
  );
}
