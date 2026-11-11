'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlatformVoiceDto } from '@rakan/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useConfirm, useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, CardHeading, ErrorState, Field, Input, LoadingState, PageHeader, formatBytes, formatDate } from '@/components/ui';
import { api, apiBinary } from '@/lib/api';
import { useI18n } from '@/lib/providers';
import { mmss, useRecorder, type Recording } from '@/lib/voice';

const MAX_SAMPLE_SECONDS = 180;

/** Platform console: create, replace or delete Rakan's official (cloned, consented) voice. */
export default function PlatformVoicePage() {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-voice'], queryFn: () => api<PlatformVoiceDto>('/platform/voice') });
  const recorder = useRecorder(MAX_SAMPLE_SECONDS, 96_000);
  const [sample, setSample] = useState<Recording | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('راكان');
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    if (!sample) return setPreview(null);
    const url = URL.createObjectURL(sample.blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [sample]);

  const done = (data: PlatformVoiceDto, msg: string) => {
    qc.setQueryData(['platform-voice'], data);
    void qc.invalidateQueries({ queryKey: ['platform-audit'] });
    void qc.invalidateQueries({ queryKey: ['voice-status'] });
    toast(msg);
  };
  const save = useMutation({
    mutationFn: async (r: Recording) => {
      const res = await apiBinary(`/platform/voice?name=${encodeURIComponent(name.trim())}&consent=accepted`, r.blob, { 'x-audio-type': r.mimeType });
      return (await res.json()) as PlatformVoiceDto;
    },
    onSuccess: (d) => {
      setSample(null);
      setConsent(false);
      done(d, t('platform.voice.saved'));
    },
  });
  const remove = useMutation({
    mutationFn: () => api<PlatformVoiceDto>('/platform/voice', { method: 'DELETE' }),
    onSuccess: (d) => done(d, t('platform.voice.deleted')),
  });

  if (q.isLoading) return <LoadingState card />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data!;

  async function record() {
    setMicError(null);
    setSample(null);
    const problem = await recorder.start((r) => setSample(r));
    if (problem) setMicError(t(problem === 'denied' ? 'voice.micDenied' : 'voice.micUnsupported'));
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (sample && consent) save.mutate(sample);
  }

  return (
    <>
      <PageHeader title={t('platform.voice.title')} subtitle={t('platform.voice.subtitle')} />
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card className="p-5 sm:p-6">
          <CardHeading>{v.configured ? t('platform.voice.replace') : t('platform.voice.setup')}</CardHeading>
          {!v.providerReady && <div className="mb-4"><Alert tone="warn">{t('platform.voice.notReady')}</Alert></div>}
          <form onSubmit={submit} className="space-y-5">
            {save.error && <Alert tone="error">{err(save.error)}</Alert>}
            <p className="text-sm text-fg-sub">{t('platform.voice.howTo')}</p>
            <div className="rounded-xl border border-line bg-subtle p-4">
              <p className="mb-1 text-xs font-medium text-fg-muted">{t('platform.voice.readThis')}</p>
              <p className="leading-loose">{t('platform.voice.script')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {recorder.recording ? (
                <>
                  <span className="size-2.5 animate-pulse rounded-full bg-danger motion-reduce:animate-none" aria-hidden />
                  <span className="tabular-nums" role="status">{mmss(recorder.seconds)} / {mmss(MAX_SAMPLE_SECONDS)}</span>
                  <Button type="button" icon="stop" onClick={() => void recorder.stop().then((r) => r && setSample(r))}>{t('platform.voice.stopRecord')}</Button>
                </>
              ) : (
                <Button type="button" variant="secondary" icon="mic" disabled={!v.providerReady || save.isPending} onClick={() => void record()}>{t('platform.voice.record')}</Button>
              )}
              <label className="text-sm text-brand-700 underline-offset-2 hover:underline">
                {t('platform.voice.orUpload')}
                <input
                  type="file" accept="audio/*" className="sr-only" disabled={!v.providerReady || recorder.recording}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setSample({ blob: f, mimeType: f.type || 'audio/mpeg', seconds: 0 });
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {micError && <Alert tone="error">{micError}</Alert>}
            {sample && preview && (
              <div className="space-y-2 rounded-xl border border-line p-3">
                <p className="text-sm font-medium">{t('platform.voice.recorded', { time: sample.seconds ? mmss(sample.seconds) : formatBytes(sample.blob.size) })}</p>
                <audio controls src={preview} className="w-full" />
              </div>
            )}

            <Field label={t('platform.voice.name')} htmlFor="voice-name">
              <Input id="voice-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} />
            </Field>

            <fieldset className="space-y-2 rounded-xl border border-accent/50 bg-accent-soft p-4">
              <legend className="px-1 text-sm font-semibold">{t('platform.voice.consent')}</legend>
              <p className="leading-relaxed">{v.consentStatement}</p>
              <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
                <input type="checkbox" className="size-5 accent-[var(--color-brand-600)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                {t('platform.voice.consentCheck')}
              </label>
            </fieldset>

            <p className="text-xs text-fg-muted">{t('platform.voice.privacy')}</p>
            <Button type="submit" icon="sparkle" className="w-full sm:w-auto" loading={save.isPending} disabled={!v.providerReady || !sample || !consent || name.trim().length < 2}>
              {v.configured ? t('platform.voice.replace') : t('platform.voice.setup')}
            </Button>
          </form>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <CardHeading>{t('platform.voice.current')}</CardHeading>
            {v.configured ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="grid size-10 place-items-center rounded-full bg-brand-50 text-brand-700" aria-hidden><Icon name="speaker" size={20} /></span>
                  <div>
                    <p className="font-semibold">{v.displayName}</p>
                    <Badge tone="accent">{t('voice.disclosure')}</Badge>
                  </div>
                </div>
                <p className="text-sm text-fg-muted">{t('platform.voice.consentedBy', { name: v.consentedByName ?? '—', date: v.consentedAt ? formatDate(v.consentedAt, locale, true) : '—' })}</p>
                {remove.error && <Alert tone="error">{err(remove.error)}</Alert>}
                <Button variant="danger" icon="trash" loading={remove.isPending}
                  onClick={async () => { if (await confirm({ title: t('platform.voice.delete'), body: t('platform.voice.deleteConfirm'), confirmLabel: t('platform.voice.delete') })) remove.mutate(); }}>
                  {t('platform.voice.delete')}
                </Button>
              </div>
            ) : <p className="text-sm text-fg-muted">{t('platform.voice.none')}</p>}
          </Card>
          <Card className="p-5">
            <p className="text-sm text-fg-sub">{t('platform.voice.pricing', { tts: v.pricing.ttsUsdPer1kChars, stt: v.pricing.sttUsdPerMinute })}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
