'use client';

import type { PushConfigDto } from '@rakan/shared';
import { api } from './api';

export type PushState = 'unsupported' | 'not_configured' | 'denied' | 'off' | 'on';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function current(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(cfg: PushConfigDto | undefined): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (!cfg?.enabled || !cfg.publicKey) return 'not_configured';
  if (Notification.permission === 'denied') return 'denied';
  return (await current()) && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Asks the browser for permission and registers this device for the signed-in person. */
export async function enablePush(cfg: PushConfigDto): Promise<PushState> {
  if (!supported() || !cfg.publicKey) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) as BufferSource }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api('/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
  return 'on';
}

/** Stops push on this device (also called at sign-out, so the next person on this browser gets nothing). */
export async function disablePush(): Promise<void> {
  if (!supported()) return;
  const sub = await current();
  if (!sub) return;
  await api('/push/subscriptions/remove', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
