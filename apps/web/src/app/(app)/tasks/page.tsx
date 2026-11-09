'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { TaskDto } from '@rakan/shared';
import Link from 'next/link';
import { useState } from 'react';
import { TaskForm } from '@/components/crm/forms';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, NoPermission, PageHeader, Tabs, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate, useMe } from '@/lib/providers';

type View = 'mine' | 'today' | 'overdue' | 'upcoming' | 'all' | 'done';

export default function TasksPage() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const me = useMe();
  const invalidate = useInvalidate();
  const [view, setView] = useState<View>('mine');
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({ queryKey: ['tasks', 'list', view], queryFn: () => api<TaskDto[]>(`/crm/tasks?view=${view}`), enabled: can('crm.task.read') });
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'done' }) => api(`/crm/tasks/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => invalidate('tasks'),
  });
  if (!can('crm.task.read')) return <NoPermission />;
  const isRep = me.data?.activeTenant?.role === 'rep';
  const views: View[] = isRep ? ['mine', 'today', 'overdue', 'upcoming', 'done'] : ['mine', 'today', 'overdue', 'upcoming', 'all', 'done'];
  const now = new Date();
  return (
    <>
      <PageHeader title={t('tasks.title')} actions={can('crm.task.write') && <Button onClick={() => setCreating(true)}>{t('tasks.new')}</Button>} />
      <Tabs tabs={views.map((v) => ({ id: v, label: t(`tasks.view.${v}`) }))} value={view} onChange={setView} label={t('tasks.title')} />
      {update.error && <div className="mb-4"><Alert tone="error">{err(update.error)}</Alert></div>}
      <Card>
        {tasks.isLoading ? (
          <LoadingState />
        ) : tasks.error ? (
          <div className="p-4"><ErrorState error={tasks.error} onRetry={() => tasks.refetch()} /></div>
        ) : !tasks.data!.length ? (
          <EmptyState>{t('tasks.empty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-100">
            {tasks.data!.map((x) => {
              const overdue = x.status === 'open' && x.dueAt && new Date(x.dueAt) < now;
              return (
                <li key={x.id} className="flex items-start gap-3 px-4 py-3">
                  {can('crm.task.write') && (
                    <input
                      type="checkbox"
                      aria-label={x.status === 'done' ? t('tasks.reopen') : t('tasks.markDone')}
                      className="mt-1 size-5 shrink-0 accent-brand-600"
                      checked={x.status === 'done'}
                      disabled={update.isPending}
                      onChange={(e) => update.mutate({ id: x.id, status: e.target.checked ? 'done' : 'open' })}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={`font-medium ${x.status === 'done' ? 'text-ink-400 line-through' : ''}`}>{x.title}</p>
                    <p className="text-sm text-ink-500">
                      {[
                        t(`tasks.type.${x.type}` as MessageKey),
                        x.dueAt && formatDate(x.dueAt, locale, true),
                        view === 'all' ? x.assigneeName : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                    {x.accountId && <Link href={`/accounts/${x.accountId}`} className="text-sm text-brand-700 hover:underline">{x.accountName}</Link>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {overdue && <Badge tone="warn">{t('tasks.overdue')}</Badge>}
                    {x.priority === 'high' && <Badge tone="warn">{t('tasks.priority.high')}</Badge>}
                    {x.createdByType === 'system' && <Badge tone="muted">{t('tasks.bySystem')}</Badge>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title={t('tasks.new')}>
        <TaskForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); invalidate('tasks'); }} />
      </Modal>
    </>
  );
}
