'use client';

/**
 * Minimal IndexedDB wrapper for the field app (no third-party dependency).
 * Stores:
 *  - cache:      last good GET responses, keyed by "<userId>:<path>" — read when the network is down.
 *  - outbox:     mutations recorded offline, replayed in order with their Idempotency-Key.
 *  - recordings: voice notes waiting to be uploaded (Blob + upload progress).
 * Everything is per user and is wiped on sign-out.
 */

const DB_NAME = 'rakan-field';
const VERSION = 1;
export type Store = 'cache' | 'outbox' | 'recordings';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['cache', 'outbox', 'recordings'] as Store[]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const idb = {
  get: <T>(store: Store, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (store: Store, key: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined).catch(() => undefined),
  del: (store: Store, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined).catch(() => undefined),
  all: <T>(store: Store) => run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>).catch(() => [] as T[]),
  clear: (store: Store) => run(store, 'readwrite', (s) => s.clear()).then(() => undefined).catch(() => undefined),
};

// ---------------------------------------------------------------- current user scope

let currentUser: string | null = null;
export function setOfflineUser(userId: string | null): void {
  currentUser = userId;
}
export const offlineUser = () => currentUser;

/** API paths whose last response is kept for offline reading. */
const CACHEABLE = [
  /^\/auth\/me$/,
  /^\/field\/today$/,
  /^\/crm\/settings$/,
  /^\/crm\/visits\/[0-9a-f-]{36}$/,
  /^\/crm\/visits\/[0-9a-f-]{36}\/recordings$/,
  /^\/crm\/accounts\/[0-9a-f-]{36}$/,
  /^\/crm\/accounts\/[0-9a-f-]{36}\/contacts$/,
  /^\/ai\/visits\/[0-9a-f-]{36}\/brief$/,
  /^\/crm\/tasks\?view=mine/,
];
export const isCacheable = (path: string) => CACHEABLE.some((r) => r.test(path));
const cacheKey = (path: string) => (path === '/auth/me' ? 'me' : `${currentUser ?? 'anon'}:${path}`);

export interface Cached<T> { data: T; at: number }
export const readCache = <T>(path: string) => idb.get<Cached<T>>('cache', cacheKey(path));
export const writeCache = (path: string, data: unknown) => idb.set('cache', cacheKey(path), { data, at: Date.now() });

// ---------------------------------------------------------------- outbox

export interface OutboxItem {
  id: string; // also the Idempotency-Key
  userId: string;
  path: string;
  method: string;
  body: unknown;
  label: string;
  createdAt: number;
  status: 'pending' | 'failed';
  error?: string;
}

export const outbox = {
  add: (item: OutboxItem) => idb.set('outbox', item.id, item).then(() => notify()),
  list: async () => (await idb.all<OutboxItem>('outbox')).filter((i) => i.userId === currentUser).sort((a, b) => a.createdAt - b.createdAt),
  remove: (id: string) => idb.del('outbox', id).then(() => notify()),
  update: (item: OutboxItem) => idb.set('outbox', item.id, item).then(() => notify()),
};

export function newKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** UI subscribers (pending count, sync state). */
const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify(): void {
  for (const fn of listeners) fn();
}

/** Sign-out: remove everything stored on this device for the user. */
export async function wipeDevice(): Promise<void> {
  await Promise.all([idb.clear('cache'), idb.clear('outbox'), idb.clear('recordings')]);
  setOfflineUser(null);
  notify();
}
