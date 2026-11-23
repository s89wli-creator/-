'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationListDto } from '@rakan/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icons';
import { cx, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';
import { PushToggle } from './PushToggle';

/** Bell with the unread count; opens the person's own notifications (from scheduled agents). */
export function NotificationBell({ tone = 'default' }: { tone?: 'default' | 'petrol' }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<NotificationListDto>('/notifications'), refetchInterval: 60_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST' }), onSuccess: refresh });
  const unread = q.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={`${t('notif.title')}${unread ? ` (${t('notif.unread', { n: unread })})` : ''}`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={cx('relative grid size-11 shrink-0 place-items-center rounded-lg transition-colors', tone === 'petrol' ? 'text-fg-sub hover:bg-subtle-strong' : 'text-fg-sub hover:bg-subtle-strong')}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="absolute end-1.5 top-1.5 grid min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.7rem] font-bold leading-5 text-petrol-deep tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label={t('notif.title')}
          className="fixed end-3 top-16 z-50 flex max-h-[min(36rem,80dvh)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-xl outline-none animate-fade-up lg:start-[18.5rem] lg:end-auto lg:top-4"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
            <h2 className="font-semibold">{t('notif.title')}</h2>
            {unread > 0 && <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => readAll.mutate()}>{t('notif.readAll')}</button>}
          </div>
          <ul className="flex-1 divide-y divide-line-soft overflow-y-auto">
            {!q.data?.items.length && <li className="px-4 py-8 text-center text-sm text-fg-muted">{t('notif.empty')}</li>}
            {q.data?.items.map((n) => (
              <li key={n.id} className={cx('space-y-1.5 px-4 py-3', !n.readAt && 'bg-brand-50/60')}>
                <div className="flex items-start gap-2">
                  {!n.readAt && <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-accent" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{n.title}</p>
                    <p className="text-xs text-fg-muted">{formatDate(n.createdAt, locale, true)}</p>
                  </div>
                  {!n.readAt && <button className="text-xs text-fg-muted hover:text-fg" onClick={() => read.mutate(n.id)} aria-label={t('notif.markRead')} title={t('notif.markRead')}><Icon name="check" size={16} /></button>}
                </div>
                {n.body && <p className="whitespace-pre-line text-sm leading-relaxed text-fg-sub">{n.body}</p>}
                {n.links.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {n.links.map((l) => (
                      <Link key={l.href} href={l.href} onClick={() => { setOpen(false); if (!n.readAt) read.mutate(n.id); }}
                        className="inline-flex min-h-8 items-center gap-1 rounded-full bg-subtle px-3 text-xs font-medium text-brand-700 hover:underline">
                        {l.label} <Icon name="chevronEnd" size={16} />
                      </Link>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <PushToggle />
        </div>,
        document.body,
      )}
    </>
  );
}
