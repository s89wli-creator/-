'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { NEXT_STEPS, VISIT_OUTCOMES, type VisitDto } from '@rakan/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, ErrorState, Field, LoadingState, Textarea, formatDate, formatTime } from '@/components/ui';
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
            value === o ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-ink-200 bg-white hover:bg-ink-50'
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
  const checkIn = useMutation({ mutationFn: async () => api<VisitDto>(`/crm/visits/${id}/check-in`, { method: 'POST', body: await getPosition() }), onSuccess: done });
  const complete = useMutation({ mutationFn: (body: object) => api<VisitDto>(`/crm/visits/${id}/complete`, { method: 'POST', body }), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api<VisitDto>(`/crm/visits/${id}/cancel`, { method: 'POST' }), onSuccess: done });

  if (visit.isLoading) return <LoadingState />;
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
      <Link href="/visits" className="text-sm text-brand-700 hover:underline">← {t('visits.title')}</Link>
      <header className="mb-4 mt-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{v.accountName}</h1>
          <Badge tone={v.status === 'completed' ? 'brand' : v.status === 'cancelled' ? 'muted' : 'neutral'}>{t(`visits.status.${v.status}` as MessageKey)}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          {formatDate(v.scheduledStart, locale, true)}{v.accountCity ? ` · ${v.accountCity}` : ''}{v.repName ? ` · ${v.repName}` : ''}
        </p>
        {v.purpose && <p className="mt-2 text-sm">{t('visits.purpose')}: {v.purpose}</p>}
        <Link href={`/accounts/${v.accountId}`} className="mt-2 inline-block text-sm text-brand-700 hover:underline">{t('common.open')}: {v.accountName}</Link>
      </header>

      {(checkIn.error || complete.error || cancel.error) && <div className="mb-4"><Alert tone="error">{err(checkIn.error ?? complete.error ?? cancel.error)}</Alert></div>}

      {v.status === 'scheduled' && writable && mine && (
        <Card className="mb-4 p-5">
          <Button className="min-h-14 w-full text-base" loading={checkIn.isPending} onClick={() => checkIn.mutate()}>{t('visits.checkIn')}</Button>
          <p className="mt-2 text-xs text-ink-500">{t('visits.checkInHint')}</p>
        </Card>
      )}
      {v.checkInAt && (
        <p className="mb-4 text-sm text-ink-500">
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
              <legend className="mb-2 text-sm font-medium text-ink-700">{t('visits.outcome')}</legend>
              <Choice name="outcome" options={VISIT_OUTCOMES} value={outcome} onChange={setOutcome} label={(o) => t(`visits.outcome.${o}` as MessageKey)} />
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink-700">{t('visits.interest')}</legend>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={interest === n}
                    aria-label={`${t('visits.interest')} ${n}`}
                    onClick={() => setInterest(interest === n ? null : n)}
                    className={`grid size-12 place-items-center rounded-full border text-sm font-semibold ${interest !== null && n <= interest ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-200 bg-white'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink-700">{t('visits.nextStep')}</legend>
              <Choice name="nextStep" options={NEXT_STEPS} value={nextStep} onChange={setNextStep} label={(o) => t(`visits.next.${o}` as MessageKey)} />
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink-700">{t('visits.followUp')}</legend>
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
        <Card className="space-y-2 p-5 text-sm">
          <p><span className="text-ink-500">{t('visits.outcome')}:</span> <strong>{v.outcome && t(`visits.outcome.${v.outcome}` as MessageKey)}</strong></p>
          {v.interestLevel && <p><span className="text-ink-500">{t('visits.interest')}:</span> {v.interestLevel}/5</p>}
          {v.nextStep && <p><span className="text-ink-500">{t('visits.nextStep')}:</span> {t(`visits.next.${v.nextStep}` as MessageKey)}</p>}
          {v.nextFollowUpAt && <p><span className="text-ink-500">{t('visits.followUp')}:</span> {formatDate(v.nextFollowUpAt, locale)}</p>}
          {v.notes && <p className="whitespace-pre-wrap border-t border-ink-100 pt-2">{v.notes}</p>}
          {v.followUpTaskId && <Alert tone="success">{t('visits.followUpCreated')}</Alert>}
        </Card>
      )}

      {v.status === 'scheduled' && writable && (
        <div className="mt-4 text-center">
          <Button variant="ghost" className="text-red-700" loading={cancel.isPending} onClick={() => window.confirm(t('visits.confirmCancel')) && cancel.mutate()}>
            {t('visits.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
