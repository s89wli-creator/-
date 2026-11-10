'use client';

import { useQuery } from '@tanstack/react-query';
import { RECORDING_CHUNK_BYTES, type AccountDto, type ContactDto, type RecordingDto, type TaskDto, type VisitBriefDto, type VisitDto } from '@rakan/shared';
import { api, ApiError, isOffline } from './api';
import { idb, newKey, notify, offlineUser, writeCache } from './offline';
import { useCan } from './providers';

export interface FieldPack {
  generatedAt: string;
  visits: VisitDto[];
  tasks: TaskDto[];
  accounts: Record<string, AccountDto & { contacts: ContactDto[] }>;
  briefs: Record<string, VisitBriefDto>;
}

/** Asks the service worker to keep today's screens available offline. */
function warmPages(paths: string[]): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'warm', paths });
}

/**
 * Today's field pack. Each successful fetch also stores the individual records on the device, so the
 * visit, account and brief screens open without a connection.
 */
export function useFieldPack() {
  const can = useCan();
  return useQuery({
    queryKey: ['field-pack'],
    enabled: can('crm.visit.read'),
    refetchInterval: 10 * 60_000,
    queryFn: async () => {
      const pack = await api<FieldPack>('/field/today');
      if (!isOffline()) {
        await Promise.all([
          ...pack.visits.map((v) => writeCache(`/crm/visits/${v.id}`, v)),
          ...Object.values(pack.accounts).flatMap(({ contacts, ...a }) => [writeCache(`/crm/accounts/${a.id}`, a), writeCache(`/crm/accounts/${a.id}/contacts`, contacts)]),
          ...Object.entries(pack.briefs).map(([vid, b]) => writeCache(`/ai/visits/${vid}/brief`, b)),
        ]);
        warmPages(['/field', '/tasks', ...pack.visits.map((v) => `/visits/${v.id}`)]);
      }
      return pack;
    },
  });
}

/** Directions link (no maps API key needed): exact pin when known, else the address. */
export function directionsUrl(a: { lat?: number | null; lng?: number | null; address?: string | null; city?: string | null; name?: string }): string | null {
  if (a.lat != null && a.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}`;
  const q = [a.address, a.city].filter(Boolean).join('، ');
  return q ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}` : null;
}

// ---------------------------------------------------------------- voice notes (resumable upload)

export interface PendingRecording {
  id: string; // local id, also the idempotency key for "start"
  userId: string;
  visitId: string;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: number;
  recordingId?: string;
  uploaded: number[];
  error?: string;
}

export const pendingRecordings = {
  add: (r: PendingRecording) => idb.set('recordings', r.id, r).then(() => notify()),
  list: async () => (await idb.all<PendingRecording>('recordings')).filter((r) => r.userId === offlineUser()),
  forVisit: async (visitId: string) => (await pendingRecordings.list()).filter((r) => r.visitId === visitId),
  remove: (id: string) => idb.del('recordings', id).then(() => notify()),
  save: (r: PendingRecording) => idb.set('recordings', r.id, r).then(() => notify()),
};

async function putChunk(recordingId: string, n: number, data: Blob): Promise<void> {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('rakan_csrf='))?.split('=')[1] ?? '');
  let res: Response;
  try {
    res = await fetch(`/api/crm/recordings/${recordingId}/chunks/${n}`, {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf }, body: data,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    throw new ApiError(res.status, body.error?.code ?? 'UNKNOWN', 'Upload failed');
  }
}

/** Uploads one pending voice note, resuming from the parts already sent. Returns the server record when done. */
export async function uploadRecording(r: PendingRecording): Promise<RecordingDto | null> {
  const total = Math.max(1, Math.ceil(r.blob.size / RECORDING_CHUNK_BYTES));
  let cur = r;
  if (!cur.recordingId) {
    const started = await api<RecordingDto>(`/crm/visits/${r.visitId}/recordings`, {
      method: 'POST',
      body: { mimeType: r.mimeType, totalChunks: total, durationSec: Math.max(1, Math.round(r.durationSec)), consent: true },
    });
    cur = { ...cur, recordingId: started.id };
    await pendingRecordings.save(cur);
  }
  for (let n = 0; n < total; n++) {
    if (cur.uploaded.includes(n)) continue;
    await putChunk(cur.recordingId!, n, r.blob.slice(n * RECORDING_CHUNK_BYTES, (n + 1) * RECORDING_CHUNK_BYTES));
    cur = { ...cur, uploaded: [...cur.uploaded, n] };
    await pendingRecordings.save(cur);
  }
  const done = await api<RecordingDto>(`/crm/recordings/${cur.recordingId}/complete`, { method: 'POST' });
  await pendingRecordings.remove(r.id);
  return done;
}

/** Uploads every pending voice note; stops quietly while offline, records business errors on the item. */
export async function uploadPendingRecordings(): Promise<number> {
  let done = 0;
  for (const r of await pendingRecordings.list()) {
    if (r.error) continue;
    try {
      await uploadRecording(r);
      done++;
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'NETWORK' && e.status !== 401 && e.status < 500) {
        await pendingRecordings.save({ ...r, error: e.code });
      } else break;
    }
  }
  return done;
}

export const newLocalId = newKey;
