'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '@/components/icons';
import { Badge, Button, Modal, cx, formatDate } from '@/components/ui';
import { isOffline, isSyncing, syncOutbox } from '@/lib/api';
import { pendingRecordings, uploadPendingRecordings, type PendingRecording } from '@/lib/field';
import { errorMessage } from '@/lib/i18n';
import { outbox, subscribe, type OutboxItem } from '@/lib/offline';
import { useI18n } from '@/lib/providers';

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      const off = subscribe(cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
        off();
      };
    },
    () => !isOffline(),
    () => true,
  );
}

/** Pending outbox items and voice notes, refreshed whenever the offline layer changes. */
export function usePending() {
  const [state, setState] = useState<{ items: OutboxItem[]; recordings: PendingRecording[]; syncing: boolean }>({ items: [], recordings: [], syncing: false });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [items, recordings] = await Promise.all([outbox.list(), pendingRecordings.list()]);
      if (alive) setState({ items, recordings, syncing: isSyncing() });
    };
    void load();
    const off = subscribe(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/**
 * Registers the service worker, replays the outbox when the connection returns (and every 30 s while
 * something is waiting), and shows a compact status bar: offline / waiting to send / failed items.
 */
export function FieldSync() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const online = useOnline();
  const { items, recordings, syncing } = usePending();
  const [open, setOpen] = useState(false);
  const pending = items.filter((i) => i.status === 'pending').length + recordings.filter((r) => !r.error).length;
  const failed = items.filter((i) => i.status === 'failed').length + recordings.filter((r) => r.error).length;

  const sync = useCallback(async () => {
    const r = await syncOutbox();
    const up = await uploadPendingRecordings();
    if (r.sent || up) void qc.invalidateQueries();
  }, [qc]);

  useEffect(() => {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
    void sync();
    // The "online" event can fire before requests actually succeed: retry a few times shortly after it.
    const timers: number[] = [];
    const onOnline = () => {
      for (const ms of [500, 2000, 5000]) timers.push(window.setTimeout(() => void sync(), ms));
    };
    window.addEventListener('online', onOnline);
    const id = window.setInterval(() => void sync(), 15_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(id);
      timers.forEach((x) => window.clearTimeout(x));
    };
  }, [sync]);

  if (online && !pending && !failed) return null;

  return (
    <>
      <div
        role="status"
        className={cx(
          'mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm',
          !online ? 'border-line-strong bg-subtle-strong text-fg' : failed ? 'border-danger-line bg-danger-soft text-fg' : 'border-brand-600/30 bg-brand-50 text-fg',
        )}
      >
        <span className="flex items-center gap-2">
          <Icon name={!online ? 'wifiOff' : 'upload'} size={16} className={!online ? 'text-fg-sub' : 'text-brand-700'} />
          {!online ? t('field.offline') : syncing ? t('field.syncing') : failed ? t('field.failedCount', { n: failed }) : t('field.waiting')}
          {pending > 0 && <Badge tone="brand">{t('field.pendingCount', { n: pending })}</Badge>}
        </span>
        <span className="flex gap-2">
          {(pending > 0 || failed > 0) && <Button variant="ghost" className="min-h-9" onClick={() => setOpen(true)}>{t('field.details')}</Button>}
          {online && pending > 0 && <Button variant="secondary" className="min-h-9" loading={syncing} onClick={() => void sync()}>{t('field.syncNow')}</Button>}
        </span>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={t('field.queueTitle')}>
        <p className="mb-3 text-sm text-fg-muted">{t('field.queueHint')}</p>
        <ul className="divide-y divide-line-soft text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div>
                <p className="font-medium">{i.label}</p>
                <p className="text-xs text-fg-muted">{formatDate(new Date(i.createdAt).toISOString(), locale, true)}</p>
                {i.error && <p className="text-xs text-danger">{errorMessage(locale, i.error)}</p>}
              </div>
              {i.status === 'failed' ? (
                <Button variant="ghost" className="min-h-9 text-danger" onClick={() => void outbox.remove(i.id)}>{t('field.discard')}</Button>
              ) : <Badge tone="warn">{t('field.waitingShort')}</Badge>}
            </li>
          ))}
          {recordings.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div>
                <p className="font-medium">{t('field.voiceNote')} · {Math.round(r.durationSec)}s</p>
                <p className="text-xs text-fg-muted">{t('field.uploadedParts', { n: r.uploaded.length })}</p>
                {r.error && <p className="text-xs text-danger">{errorMessage(locale, r.error)}</p>}
              </div>
              {r.error ? (
                <Button variant="ghost" className="min-h-9 text-danger" onClick={() => void pendingRecordings.remove(r.id)}>{t('field.discard')}</Button>
              ) : <Badge tone="warn">{t('field.waitingShort')}</Badge>}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
