'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { NEXT_STEPS, VISIT_OUTCOMES, type VisitDto } from '@rakan/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { MeetingInsightsPanel, VisitBriefPanel } from '@/components/ai/panels';
import { Alert, BackLink, Badge, Button, Card, ErrorState, Field, LoadingState, Textarea, cx, formatDate, formatTime } from '@/components/ui';
import { useConfirm, useToast } from '@/components/feedback';
import { api } from '@/lib/api';
import { isoDaysFromNow } from '@/lib/crm';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate, useMe } from '@/lib/providers';

/** Optional location: asked once, short timeout, never blocks the visit. */
function getPosition(): Promise<{ lat?: number; lng?: number; accuracyM?: number }> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

function Choice<T extends string>({ name, options, value, onChange, label }: { name: string; options: readonly T[]; value: T | null; onChange: (v: T) => void; label: (v: T) => string }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
      {options.map((o) => (
        <label
          key={o}
          className={`flex min-h-12 cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-sm font-medium ${
            value === o ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-surface transition-colors duration-150 hover:bg-subtle'
          }`}
        >
          <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} className="sr-only" />
          {label(o)}
        </label>
      ))}
    </div>
  );
}

const FOLLOW_UPS = [
  { key: 'tomorrow', days: 1 },
  { key: '3days', days: 3 },
  { key: 'week', days: 7 },
  { key: 'none', days: null },
] as const;

export default function VisitPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const { t, err, locale } = useI18n();
  const can = useCan();
  const me = useMe();
  const invalidate = useInvalidate();
  const [outcome, setOutcome] = useState<(typeof VISIT_OUTCOMES)[number] | null>(null);
  const [nextStep, setNextStep] = useState<(typeof NEXT_STEPS)[number] | null>(null);
  const [interest, setInterest] = useState<number | null>(null);
  const [followUp, setFollowUp] = useState<(typeof FOLLOW_UPS)[number]['key']>('3days');
  const [formError, setFormError] = useState(false);

  const visit = useQuery({ queryKey: ['visit', id], queryFn: () => api<VisitDto>(`/crm/visits/${id}`) });
  const done = (v: VisitDto) => {
    invalidate('visit');
    invalidate('visits');
    invalidate('tasks');
    return v;
  };
  const checkIn = useMutation({
    mutationFn: async () => api<VisitDto>(`/crm/visits/${id}/check-in`, { method: 'POST', body: await getPosition() }),
    onSuccess: (v) => {
      toast(t('toast.checkedIn'));
      return done(v);
    },
  });
  const complete = useMutation({
    mutationFn: (body: object) => api<VisitDto>(`/crm/visits/${id}/complete`, { method: 'POST', body }),
    onSuccess: (v) => {
      toast(t('toast.visitSaved'));
      window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return done(v);
    },
  });
  const cancel = useMutation({ mutationFn: () => api<VisitDto>(`/crm/visits/${id}/cancel`, { method: 'POST' }), onSuccess: done });

  if (visit.isLoading) return <LoadingState card />;
  if (visit.error) return <ErrorState error={visit.error} onRetry={() => visit.refetch()} />;
  const v = visit.data!;
  const mine = me.data?.activeTenant?.membershipId === v.repMembershipId;
  const writable = can('crm.visit.write') && (mine || me.data?.activeTenant?.role !== 'rep');
  const open = v.status === 'scheduled' || v.status === 'in_progress';

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!outcome || !nextStep) return setFormError(true);
    setFormError(false);
    const days = FOLLOW_UPS.find((f) => f.key === followUp)!.days;
    complete.mutate({
      outcome, nextStep, interestLevel: interest,
      nextFollowUpAt: days === null ? null : isoDaysFromNow(days),
      notes: String(new FormData(e.currentTarget).get('notes') ?? '').trim() || null,
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <BackLink href="/visits">{t('visits.title')}</BackLink>
      <header className="mb-4 mt-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{v.accountName}</h1>
          <Badge tone={v.status === 'completed' ? 'brand' : v.status === 'cancelled' ? 'muted' : 'neutral'}>{t(`visits.status.${v.status}` as MessageKey)}</Badge>
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          {formatDate(v.scheduledStart, locale, true)}{v.accountCity ? ` · ${v.accountCity}` : ''}{v.repName ? ` · ${v.repName}` : ''}
        </p>
        {v.purpose && <p className="mt-2 text-sm">{t('visits.purpose')}: {v.purpose}</p>}
        <Link href={`/accounts/${v.accountId}`} className="mt-2 inline-block text-sm text-brand-700 hover:underline">{t('common.open')}: {v.accountName}</Link>
      </header>

      {(checkIn.error || complete.error || cancel.error) && <div className="mb-4"><Alert tone="error">{err(checkIn.error ?? complete.error ?? cancel.error)}</Alert></div>}

      {v.status === 'scheduled' && writable && mine && (
        <Card className="mb-4 p-5">
          <Button icon="pin" className="min-h-14 w-full text-base" loading={checkIn.isPending} onClick={() => checkIn.mutate()}>{t('visits.checkIn')}</Button>
          <p className="mt-2 text-xs text-fg-muted">{t('visits.checkInHint')}</p>
        </Card>
      )}
      {v.checkInAt && (
        <p className="mb-4 text-sm text-fg-muted">
          {t('visits.checkedInAt', { time: formatTime(v.checkInAt, locale) })}
          {v.checkInLat !== null && ` · ${t('visits.withLocation')}`}
          {v.checkOutAt && ` · ${t('visits.checkedOutAt', { time: formatTime(v.checkOutAt, locale) })}`}
        </p>
      )}

      {open && writable && (
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-5" noValidate>
            <h2 className="text-lg font-semibold">{t('visits.recordOutcome')}</h2>
            {formError && <Alert tone="error">{t('form.required')}</Alert>}
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-fg-sub">{t('visits.outcome')}</legend>
              <Choice name="outcome" options={VISIT_OUTCOMES} value={outcome} onChange={setOutcome} label={(o) => t(`visits.outcome.${o}` as MessageKey)} />
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-fg-sub">{t('visits.interest')}</legend>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={interest === n}
                    aria-label={`${t('visits.interest')} ${n}`}
                    onClick={() => setInterest(interest === n ? null : n)}
                    className={cx(
                      'grid size-12 place-items-center rounded-full border-2 text-sm font-semibold transition-[background-color,border-color,color,transform] duration-200 active:scale-95',
                      interest !== null && n <= interest ? 'border-brand-600 bg-brand-600 text-on-brand' : 'border-line bg-surface text-fg-sub hover:border-line-strong',
                    )}
                    style={{ transitionDelay: interest !== null && n <= interest ? `${(n - 1) * 30}ms` : '0ms' }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-fg-sub">{t('visits.nextStep')}</legend>
              <Choice name="nextStep" options={NEXT_STEPS} value={nextStep} onChange={setNextStep} label={(o) => t(`visits.next.${o}` as MessageKey)} />
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-fg-sub">{t('visits.followUp')}</legend>
              <Choice name="followUp" options={FOLLOW_UPS.map((f) => f.key)} value={followUp} onChange={setFollowUp} label={(o) => t(`visits.followUp.${o}` as MessageKey)} />
            </fieldset>
            <Field label={t('common.notes')} htmlFor="visit-notes" optional>
              <Textarea id="visit-notes" name="notes" rows={4} />
            </Field>
            <Button type="submit" className="min-h-14 w-full text-base" loading={complete.isPending}>{t('common.save')}</Button>
          </form>
        </Card>
      )}

      {v.status === 'completed' && (
        <Card className="animate-fade-up space-y-2 p-5 text-sm">
          <p><span className="text-fg-muted">{t('visits.outcome')}:</span> <strong>{v.outcome && t(`visits.outcome.${v.outcome}` as MessageKey)}</strong></p>
          {v.interestLevel && <p><span className="text-fg-muted">{t('visits.interest')}:</span> {v.interestLevel}/5</p>}
          {v.nextStep && <p><span className="text-fg-muted">{t('visits.nextStep')}:</span> {t(`visits.next.${v.nextStep}` as MessageKey)}</p>}
          {v.nextFollowUpAt && <p><span className="text-fg-muted">{t('visits.followUp')}:</span> {formatDate(v.nextFollowUpAt, locale)}</p>}
          {v.notes && <p className="whitespace-pre-wrap border-t border-line-soft pt-2">{v.notes}</p>}
          {v.followUpTaskId && <Alert tone="success">{t('visits.followUpCreated')}</Alert>}
        </Card>
      )}

      {can('ai.use') && v.status !== 'cancelled' && (
        <div className="mt-4 space-y-4">
          {v.status !== 'completed' && <VisitBriefPanel visitId={v.id} />}
          {v.status === 'completed' && <MeetingInsightsPanel visitId={v.id} />}
        </div>
      )}

      {v.status === 'scheduled' && writable && (
        <div className="mt-4 text-center">
          <Button variant="ghost" className="text-danger" loading={cancel.isPending} onClick={() => void confirm({ title: t('visits.confirmCancel'), tone: 'danger', confirmLabel: t('visits.cancel') }).then((ok) => ok && cancel.mutate())}>
            {t('visits.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
