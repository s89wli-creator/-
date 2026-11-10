'use client';

import { useQuery } from '@tanstack/react-query';
import type { OpportunityDto } from '@rakan/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MoveStageForm, OpportunityForm } from '@/components/crm/forms';
import { useToast } from '@/components/feedback';
import { Icon } from '@/components/icons';
import { Button, Card, EmptyState, ErrorState, LoadingState, Modal, NoPermission, PageHeader, Select, Skeleton, cx, formatMoney } from '@/components/ui';
import { api } from '@/lib/api';
import { useCrmSettings } from '@/lib/crm';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

export default function PipelinePage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const invalidate = useInvalidate();
  const settings = useCrmSettings();
  const [pipelineId, setPipelineId] = useState('');
  const [move, setMove] = useState<{ opp: OpportunityDto; stageId?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const toast = useToast();

  // One request for all pipelines; the board shows the selected one. Default: the pipeline with the most deals.
  const all = useQuery({
    queryKey: ['opps', 'board'],
    queryFn: () => api<OpportunityDto[]>('/crm/opportunities'),
    enabled: can('crm.opportunity.read'),
  });
  useEffect(() => {
    if (pipelineId || !settings.data || !all.data) return;
    const counts = new Map<string, number>();
    for (const o of all.data) counts.set(o.pipelineId, (counts.get(o.pipelineId) ?? 0) + 1);
    const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    setPipelineId(busiest ?? settings.data.pipelines.find((p) => p.isDefault)?.id ?? settings.data.pipelines[0]?.id ?? '');
  }, [settings.data, all.data, pipelineId]);
  const opps = { ...all, data: all.data?.filter((o) => o.pipelineId === pipelineId) };

  if (!can('crm.opportunity.read')) return <NoPermission />;
  if (settings.isLoading) return <LoadingState card />;
  const stageName = (id: string) => settings.data?.pipelines.flatMap((p) => p.stages).find((x) => x.id === id)?.name ?? '';
  const pipeline = settings.data?.pipelines.find((p) => p.id === pipelineId);
  const trackName = (id: string | null) => settings.data?.tracks.find((x) => x.id === id)?.name;
  const writable = can('crm.opportunity.write');

  return (
    <>
      <PageHeader
        title={t('pipeline.title')}
        subtitle={writable ? t('pipeline.subtitle') : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {(settings.data?.pipelines.length ?? 0) > 1 && (
              <Select aria-label={t('pipeline.choose')} value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className="w-56">
                {settings.data!.pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.trackId ? `${t('accounts.track')}: ${trackName(p.trackId)}` : p.name} ({all.data?.filter((o) => o.pipelineId === p.id).length ?? 0})
                  </option>
                ))}
              </Select>
            )}
            {writable && <Button icon="plus" onClick={() => setCreating(true)}>{t('opps.new')}</Button>}
          </div>
        }
      />
      {opps.error ? (
        <ErrorState error={opps.error} onRetry={() => opps.refetch()} />
      ) : !pipeline || opps.isLoading ? (
        <div className="flex gap-3 overflow-hidden" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="w-72 shrink-0 space-y-3 rounded-xl bg-subtle p-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-8 sm:px-8" role="list" aria-label={pipeline.name}>
          <div className="flex gap-3">
            {pipeline.stages.map((s) => {
              const items = opps.data!.filter((o) => o.stageId === s.id);
              const value = items.reduce((sum, o) => sum + (o.amount ?? 0), 0);
              return (
                <section
                  key={s.id}
                  role="listitem"
                  aria-label={s.name}
                  onDragOver={(e) => {
                    if (!writable) return;
                    e.preventDefault();
                    setDragOver(s.id);
                  }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    setDragOver(null);
                    const opp = opps.data!.find((o) => o.id === e.dataTransfer.getData('text/plain'));
                    if (opp && opp.stageId !== s.id) setMove({ opp, stageId: s.id });
                  }}
                  className={cx(
                    'flex w-72 shrink-0 flex-col rounded-xl border-2 p-2 transition-[background-color,border-color] duration-200',
                    dragOver === s.id ? 'border-brand-600 border-dashed bg-brand-50' : 'border-transparent bg-subtle',
                  )}
                >
                  <header className="flex items-start justify-between gap-2 px-2 pb-3 pt-1">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-2 text-sm font-semibold">
                        <span aria-hidden className={cx('size-2 rounded-full', s.category === 'won' ? 'bg-success' : s.category === 'lost' ? 'bg-danger' : s.category === 'postponed' ? 'bg-warn' : 'bg-brand-600')} />
                        {s.name}
                      </h2>
                      <p className="mt-0.5 text-xs text-fg-muted tabular-nums">{formatMoney(value, locale)}</p>
                    </div>
                    <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold tabular-nums text-fg-sub shadow-xs">{items.length}</span>
                  </header>
                  <div className="flex min-h-16 flex-col gap-2">
                    {items.map((o) => (
                      <Card
                        key={`${o.id}-${o.stageId}`}
                        as="article"
                        className={cx(
                          'animate-fade-up p-3 transition-[transform,box-shadow,opacity] duration-200',
                          dragging === o.id ? 'rotate-1 scale-[1.02] opacity-60 shadow-md' : 'hover:shadow-md',
                        )}
                      >
                        <div
                          draggable={writable}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', o.id);
                            e.dataTransfer.effectAllowed = 'move';
                            setDragging(o.id);
                          }}
                          onDragEnd={() => setDragging(null)}
                          className={writable ? 'cursor-grab active:cursor-grabbing' : ''}
                        >
                          <Link href={`/accounts/${o.accountId}`} className="block text-sm font-medium hover:underline">{o.accountName}</Link>
                          <p className="text-sm text-fg-sub">{o.title}</p>
                          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                            <span className="font-semibold tabular-nums text-fg">{formatMoney(o.amount, locale)}</span>
                            <span className="truncate text-fg-muted">{o.ownerName ?? t('common.unassigned')}</span>
                          </div>
                        </div>
                        {writable && (
                          <Button variant="ghost" className="mt-2 min-h-9 w-full border-t border-line-soft px-2 text-xs" onClick={() => setMove({ opp: o })}>
                            {t('opps.moveTo')} <Icon name="chevronEnd" size={16} />
                          </Button>
                        )}
                      </Card>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          {opps.data!.length === 0 && <EmptyState icon="kanban">{t('pipeline.empty')}</EmptyState>}
        </div>
      )}
      <Modal open={!!move} onClose={() => setMove(null)} title={t('opps.moveTo')}>
        {move && pipeline && (
          <MoveStageForm
            opportunity={move.opp}
            pipeline={pipeline}
            targetStageId={move.stageId}
            onCancel={() => setMove(null)}
            onDone={(o) => {
              setMove(null);
              toast(t('toast.stageMoved', { stage: stageName(o.stageId) }));
              invalidate('opps');
            }}
          />
        )}
      </Modal>
      <Modal open={creating} onClose={() => setCreating(false)} title={t('opps.new')}>
        <OpportunityForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); toast(t('toast.created')); invalidate('opps'); }} />
      </Modal>
    </>
  );
}
