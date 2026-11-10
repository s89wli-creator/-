'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { TaskDto } from '@rakan/shared';
import Link from 'next/link';
import { useState } from 'react';
import { TaskForm } from '@/components/crm/forms';
import { useToast } from '@/components/feedback';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, NoPermission, PageHeader, Tabs, cx, formatDate } from '@/components/ui';
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
  const toast = useToast();
  // Optimistic: the row shows its new state immediately; the list refreshes after the server confirms.
  const [local, setLocal] = useState<Record<string, 'open' | 'done'>>({});
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'done' }) => api(`/crm/tasks/${id}`, { method: 'PATCH', body: { status } }),
    onMutate: ({ id, status }) => setLocal((m) => ({ ...m, [id]: status })),
    onError: (_e, { id }) => setLocal(({ [id]: _drop, ...rest }) => rest),
    onSuccess: (_d, { status }) => {
      toast(t(status === 'done' ? 'toast.taskDone' : 'toast.taskReopened'));
      window.setTimeout(() => {
        setLocal({});
        invalidate('tasks');
      }, 600);
    },
  });
  if (!can('crm.task.read')) return <NoPermission />;
  const isRep = me.data?.activeTenant?.role === 'rep';
  const views: View[] = isRep ? ['mine', 'today', 'overdue', 'upcoming', 'done'] : ['mine', 'today', 'overdue', 'upcoming', 'all', 'done'];
  const now = new Date();
  return (
    <>
      <PageHeader title={t('tasks.title')} actions={can('crm.task.write') && <Button icon="plus" onClick={() => setCreating(true)}>{t('tasks.new')}</Button>} />
      <Tabs tabs={views.map((v) => ({ id: v, label: t(`tasks.view.${v}`) }))} value={view} onChange={setView} label={t('tasks.title')} />
      {update.error && <div className="mb-4"><Alert tone="error">{err(update.error)}</Alert></div>}
      <Card>
        {tasks.isLoading ? (
          <LoadingState />
        ) : tasks.error ? (
          <div className="p-4"><ErrorState error={tasks.error} onRetry={() => tasks.refetch()} /></div>
        ) : !tasks.data!.length ? (
          <EmptyState icon="checkSquare" action={can('crm.task.write') && <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>{t('tasks.new')}</Button>}>{t('tasks.empty')}</EmptyState>
        ) : (
          <ul className="stagger divide-y divide-line-soft">
            {tasks.data!.map((x) => {
              const status = local[x.id] ?? x.status;
              const overdue = status === 'open' && x.dueAt && new Date(x.dueAt) < now;
              return (
                <li key={x.id} className={cx('flex items-start gap-3 px-4 py-3.5 transition-opacity duration-300', local[x.id] && local[x.id] !== x.status && 'opacity-60')}>
                  {can('crm.task.write') && (
                    <button
                      role="checkbox"
                      aria-checked={status === 'done'}
                      aria-label={status === 'done' ? t('tasks.reopen') : t('tasks.markDone')}
                      disabled={update.isPending && update.variables?.id === x.id}
                      onClick={() => update.mutate({ id: x.id, status: status === 'done' ? 'open' : 'done' })}
                      className="-m-2.5 grid size-11 shrink-0 place-items-center rounded-full"
                    >
                      <span
                        className={cx(
                          'grid size-6 place-items-center rounded-full border-2 transition-[background-color,border-color,transform] duration-200 active:scale-90',
                          status === 'done' ? 'border-brand-600 bg-brand-600 text-on-brand' : 'border-line-strong bg-surface hover:border-brand-600',
                        )}
                      >
                        {status === 'done' && (
                          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="check-draw" aria-hidden>
                            <path d="M5 12.5 10 17.5 19 7" />
                          </svg>
                        )}
                      </span>
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="relative inline-block font-medium">
                      <span className={cx('transition-colors duration-300', status === 'done' && 'text-fg-muted')}>{x.title}</span>
                      <span
                        aria-hidden
                        className={cx(
                          'absolute inset-x-0 top-1/2 h-px origin-right bg-fg-muted transition-transform duration-300 ease-out ltr:origin-left',
                          status === 'done' ? 'scale-x-100' : 'scale-x-0',
                        )}
                      />
                    </p>
                    <p className="text-sm text-fg-muted">
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
        <TaskForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); toast(t('toast.created')); invalidate('tasks'); }} />
      </Modal>
    </>
  );
}
