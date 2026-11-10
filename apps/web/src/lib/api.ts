'use client';

import { isCacheable, newKey, notify, offlineUser, outbox, readCache, writeCache } from './offline';

/** Error carrying the API's stable error code (translated in the UI). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
  fieldError(path: string): string | undefined {
    return this.details?.find((d) => d.path === path)?.message;
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(name + '='))
    ?.split('=')[1];
}

async function csrfToken(): Promise<string> {
  const existing = readCookie('rakan_csrf');
  if (existing) return decodeURIComponent(existing);
  const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

/** Returned (instead of throwing) when a mutation was saved on the device to be sent later. */
export interface Queued { queued: true; id: string }
export const isQueued = (v: unknown): v is Queued => !!v && typeof v === 'object' && (v as Queued).queued === true;

interface ApiInit {
  method?: string;
  body?: unknown;
  /** Field-app mutation: sent with an Idempotency-Key, and saved to the outbox when the network is down. */
  offline?: { label: string };
}

async function send(path: string, method: string, body: unknown, idempotencyKey?: string): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  try {
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = await csrfToken();
    }
    return await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } }).error ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? res.statusText, err.details as ApiError['details']);
  }
  return data as T;
}

export function api<T>(path: string, init: ApiInit & { offline: { label: string } }): Promise<T | Queued>;
export function api<T>(path: string, init?: ApiInit): Promise<T>;
export async function api<T>(path: string, init: ApiInit = {}): Promise<T | Queued> {
  const method = init.method ?? 'GET';
  if (method === 'GET') {
    try {
      const data = await parse<T>(await send(path, 'GET', undefined));
      if (isCacheable(path)) void writeCache(path, data);
      return data;
    } catch (e) {
      // Network down: serve the last copy saved on this device, if any.
      if (e instanceof ApiError && e.code === 'NETWORK' && isCacheable(path)) {
        const cached = await readCache<T>(path);
        if (cached) {
          markOffline(true);
          return cached.data;
        }
      }
      throw e;
    }
  }
  const key = init.offline ? newKey() : undefined;
  try {
    const out = await parse<T>(await send(path, method, init.body, key));
    markOffline(false);
    return out;
  } catch (e) {
    const userId = offlineUser();
    if (init.offline && key && userId && e instanceof ApiError && e.code === 'NETWORK') {
      markOffline(true);
      await outbox.add({ id: key, userId, path, method, body: init.body, label: init.offline.label, createdAt: Date.now(), status: 'pending' });
      return { queued: true, id: key };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- connectivity + outbox replay

let offlineFlag = false;
export const isOffline = () => offlineFlag || (typeof navigator !== 'undefined' && navigator.onLine === false);
function markOffline(v: boolean): void {
  if (offlineFlag !== v) {
    offlineFlag = v;
    notify();
  }
}

let syncing: Promise<{ sent: number; failed: number }> | null = null;
export const isSyncing = () => syncing !== null;

/**
 * Replays the outbox in order. Each item keeps its Idempotency-Key, so a request that reached the server
 * before the connection dropped is not applied twice. Stops at the first network error (still offline).
 * A business error (e.g. the visit was cancelled meanwhile) marks the item failed for the user to review.
 */
export function syncOutbox(): Promise<{ sent: number; failed: number }> {
  syncing ??= (async () => {
    let sent = 0;
    let failed = 0;
    notify();
    try {
      for (const item of await outbox.list()) {
        if (item.status === 'failed') continue;
        try {
          await parse(await send(item.path, item.method, item.body, item.id));
          await outbox.remove(item.id);
          sent++;
          markOffline(false);
        } catch (e) {
          if (!(e instanceof ApiError) || e.code === 'NETWORK') {
            markOffline(true);
            break;
          }
          if (e.status === 401 || e.status === 429 || e.status >= 500 || e.code === 'IDEMPOTENCY_IN_PROGRESS' || e.code === 'CSRF_INVALID') break;
          await outbox.update({ ...item, status: 'failed', error: e.code });
          failed++;
        }
      }
    } finally {
      syncing = null;
      notify();
    }
    return { sent, failed };
  })();
  return syncing;
}
