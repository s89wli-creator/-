'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { RecordingDto } from '@rakan/shared';
import { useEffect, useRef, useState } from 'react';
import { useConfirm, useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, Field, Textarea, formatDate } from '@/components/ui';
import { api, isOffline } from '@/lib/api';
import { newLocalId, pendingRecordings, uploadRecording, type PendingRecording } from '@/lib/field';
import { offlineUser, subscribe } from '@/lib/offline';
import { useI18n, useInvalidate } from '@/lib/providers';

const MAX_SECONDS = 30 * 60;

function pickMime(): string {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return prefs.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Voice notes for a visit. Recording needs the company setting and the customer's consent each time.
 * The audio is saved on the phone first, then uploaded in parts (resumes after a lost connection).
 * Automatic transcription is not connected yet; the rep can type or paste the transcript.
 */
export function VoiceNotes({ visitId, canWrite }: { visitId: string; canWrite: boolean }) {
  const { t, err, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const list = useQuery({ queryKey: ['recordings', visitId], queryFn: () => api<RecordingDto[]>(`/crm/visits/${visitId}/recordings`) });
  const [pending, setPending] = useState<PendingRecording[]>([]);
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number; timer: number } | null>(null);

  useEffect(() => {
    const load = () => void pendingRecordings.forVisit(visitId).then(setPending);
    load();
    return subscribe(load);
  }, [visitId]);
  useEffect(() => () => rec.current?.stream.getTracks().forEach((tr) => tr.stop()), []);

  const upload = useMutation({
    mutationFn: (r: PendingRecording) => uploadRecording(r),
    onSuccess: () => {
      toast(t('voice.uploaded'));
      invalidate('recordings');
    },
  });

  async function start() {
    setError(null);
    const mime = pickMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) return setError(t('voice.unsupported'));
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError(t('voice.micDenied'));
    }
    const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.start(1000);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setSeconds(s);
      if (s >= MAX_SECONDS) void stop();
    }, 250);
    rec.current = { mr, stream, chunks, started, timer };
    setSeconds(0);
    setState('recording');
  }

  async function stop() {
    const r = rec.current;
    if (!r) return;
    setState('saving');
    window.clearInterval(r.timer);
    await new Promise<void>((resolve) => {
      r.mr.onstop = () => resolve();
      r.mr.stop();
    });
    r.stream.getTracks().forEach((tr) => tr.stop());
    rec.current = null;
    const mimeType = r.mr.mimeType.split(';')[0]!;
    const item: PendingRecording = {
      id: newLocalId(), userId: offlineUser() ?? '', visitId, blob: new Blob(r.chunks, { type: mimeType }), mimeType,
      durationSec: (Date.now() - r.started) / 1000, createdAt: Date.now(), uploaded: [],
    };
    await pendingRecordings.add(item); // saved on the phone first: nothing is lost if the network drops
    setState('idle');
    setConsent(false);
    if (isOffline()) toast(t('voice.savedOffline'), 'info');
    else upload.mutate(item);
  }

  const items = list.data ?? [];
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-700" aria-hidden><Icon name="mic" size={20} /></span>
        <div>
          <h3 className="font-semibold">{t('voice.title')}</h3>
          <p className="text-xs text-fg-muted">{t('voice.hint')}</p>
        </div>
      </div>
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        {upload.error && <Alert tone="error">{err(upload.error)}</Alert>}

        {canWrite && state === 'idle' && (
          <div className="space-y-3 rounded-lg bg-subtle p-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 size-5 shrink-0 accent-brand-600" />
              <span>{t('voice.consent')}</span>
            </label>
            <Button className="min-h-12 w-full" icon="mic" disabled={!consent} onClick={() => void start()}>{t('voice.start')}</Button>
          </div>
        )}
        {state !== 'idle' && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-danger-line bg-danger-soft p-3" role="status">
            <span className="flex items-center gap-2 font-medium">
              <span className="size-3 animate-pulse rounded-full bg-danger motion-reduce:animate-none" aria-hidden />
              {t('voice.recording')} <span className="tabular-nums" dir="ltr">{mmss(seconds)}</span>
            </span>
            <Button variant="danger-solid" loading={state === 'saving'} onClick={() => void stop()}>{t('voice.stop')}</Button>
          </div>
        )}

        {pending.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
            <span>{t('voice.pending', { s: Math.round(p.durationSec) })}{p.error && <span className="text-danger"> · {p.error}</span>}</span>
            <Button variant="secondary" className="min-h-9" loading={upload.isPending && upload.variables?.id === p.id} onClick={() => upload.mutate(p)}>{t('voice.retry')}</Button>
          </div>
        ))}

        {items.map((r) => <RecordingItem key={r.id} r={r} canWrite={canWrite} locale={locale} onDelete={async () => {
          if (await confirm({ title: t('voice.deleteConfirm'), tone: 'danger', confirmLabel: t('common.delete') })) {
            await api(`/crm/recordings/${r.id}`, { method: 'DELETE' });
            invalidate('recordings');
          }
        }} />)}
        {!items.length && !pending.length && state === 'idle' && <p className="text-sm text-fg-muted">{t('voice.empty')}</p>}
      </div>
    </Card>
  );
}

function RecordingItem({ r, canWrite, locale, onDelete }: { r: RecordingDto; canWrite: boolean; locale: 'ar' | 'en'; onDelete: () => void }) {
  const { t, err } = useI18n();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (transcript: string) => api<RecordingDto>(`/crm/recordings/${r.id}/transcript`, { method: 'PATCH', body: { transcript } }),
    onSuccess: () => {
      setEditing(false);
      toast(t('common.saveSuccess'));
      invalidate('recordings');
    },
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-fg-muted">
          {formatDate(r.createdAt, locale, true)}{r.durationSec && ` · ${mmss(r.durationSec)}`}{r.uploadedByName && ` · ${r.uploadedByName}`}
        </span>
        <Badge tone="muted">{t('voice.deletesOn', { date: formatDate(r.deleteAfter, locale) })}</Badge>
      </div>
      {r.status === 'ready' ? <audio controls preload="none" src={`/api/crm/recordings/${r.id}/audio`} className="w-full" /> : <Badge tone="warn">{t('voice.uploading')}</Badge>}
      {r.transcript && !editing && <p className="whitespace-pre-wrap rounded-md bg-subtle p-2">{r.transcript}</p>}
      {!r.transcript && !editing && <p className="text-xs text-fg-muted">{t('voice.noStt')}</p>}
      {editing ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(String(new FormData(e.currentTarget).get('transcript') ?? '')); }}>
          {save.error && <Alert tone="error">{err(save.error)}</Alert>}
          <Field label={t('voice.transcript')} htmlFor={`tr-${r.id}`}>
            <Textarea id={`tr-${r.id}`} name="transcript" rows={5} defaultValue={r.transcript ?? ''} required maxLength={20000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
            <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      ) : canWrite && (
        <div className="flex gap-2">
          <Button variant="ghost" className="min-h-9" onClick={() => setEditing(true)}>{t(r.transcript ? 'voice.editTranscript' : 'voice.addTranscript')}</Button>
          <Button variant="ghost" className="min-h-9 text-danger" onClick={onDelete}>{t('common.delete')}</Button>
        </div>
      )}
    </div>
  );
}
