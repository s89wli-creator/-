'use client';

import { useQuery } from '@tanstack/react-query';
import type { VoiceStatusDto } from '@rakan/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBinary } from './api';

export function useVoiceStatus(enabled = true) {
  return useQuery({ queryKey: ['voice-status'], queryFn: () => api<VoiceStatusDto>('/ai/voice/status'), enabled, staleTime: 60_000 });
}

export function pickAudioMime(): string {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return prefs.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface Recording { blob: Blob; mimeType: string; seconds: number }
export type RecorderError = 'unsupported' | 'denied';

/** Microphone recorder that stops by itself at `maxSeconds`. */
export function useRecorder(maxSeconds: number, bitsPerSecond = 32_000) {
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number; timer: number; done: (r: Recording | null) => void; cancelled: boolean } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const onAutoStop = useRef<((r: Recording) => void) | null>(null);

  const cleanup = () => {
    const r = rec.current;
    if (!r) return;
    window.clearInterval(r.timer);
    r.stream.getTracks().forEach((tr) => tr.stop());
    rec.current = null;
    setRecording(false);
  };

  useEffect(() => () => {
    if (rec.current) {
      rec.current.cancelled = true;
      if (rec.current.mr.state !== 'inactive') rec.current.mr.stop();
      cleanup();
    }
  }, []);

  const finish = (): Promise<Recording | null> =>
    new Promise((resolve) => {
      const r = rec.current;
      if (!r) return resolve(null);
      r.done = resolve;
      if (r.mr.state !== 'inactive') r.mr.stop();
    });

  const start = useCallback(async (autoStop?: (r: Recording) => void): Promise<RecorderError | null> => {
    const mime = pickAudioMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) return 'unsupported';
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return 'denied';
    }
    const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: bitsPerSecond });
    const chunks: Blob[] = [];
    const started = Date.now();
    onAutoStop.current = autoStop ?? null;
    const state = { mr, stream, chunks, started, timer: 0, done: (() => undefined) as (r: Recording | null) => void, cancelled: false };
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const result = state.cancelled ? null : { blob: new Blob(chunks, { type: mr.mimeType.split(';')[0] }), mimeType: mr.mimeType, seconds: (Date.now() - started) / 1000 };
      cleanup();
      state.done(result);
    };
    state.timer = window.setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setSeconds(s);
      if (s >= maxSeconds && rec.current === state) {
        void finish().then((r) => r && onAutoStop.current?.(r));
      }
    }, 250);
    rec.current = state;
    setSeconds(0);
    setRecording(true);
    mr.start(1000);
    return null;
  }, [maxSeconds, bitsPerSecond]);

  const stop = useCallback(() => finish(), []);
  const cancel = useCallback(() => {
    if (rec.current) rec.current.cancelled = true;
    void finish();
  }, []);

  return { start, stop, cancel, recording, seconds };
}

export async function transcribe(r: Recording): Promise<string> {
  const res = await apiBinary('/ai/assistant/transcribe', r.blob, { 'x-audio-type': r.mimeType, 'x-audio-seconds': String(Math.ceil(r.seconds)) });
  return ((await res.json()) as { text: string }).text;
}

/** Plays Ask Rakan replies in the spokesperson voice; one at a time, clips kept for replay in this tab. */
export function useReplyPlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<number, string>());
  const [playing, setPlaying] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);

  useEffect(() => {
    const map = urls.current;
    return () => {
      audio.current?.pause();
      map.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const stop = useCallback(() => {
    audio.current?.pause();
    setPlaying(null);
  }, []);

  const play = useCallback(async (messageId: number) => {
    audio.current?.pause();
    setPlaying(null);
    let url = urls.current.get(messageId);
    if (!url) {
      setLoading(messageId);
      try {
        const res = await apiBinary(`/ai/assistant/messages/${messageId}/speech`, undefined);
        url = URL.createObjectURL(await res.blob());
        urls.current.set(messageId, url);
      } finally {
        setLoading(null);
      }
    }
    const el = (audio.current ??= new Audio());
    el.src = url;
    el.onended = () => setPlaying(null);
    el.onpause = () => setPlaying((p) => (p === messageId ? null : p));
    setPlaying(messageId);
    try {
      await el.play();
    } catch {
      setPlaying(null);
    }
  }, []);

  return { play, stop, playing, loading };
}
