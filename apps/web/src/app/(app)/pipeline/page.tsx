'use client';

import { useQuery } from '@tanstack/react-query';
import type { OpportunityDto } from '@rakan/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MoveStageForm, OpportunityForm } from '@/components/crm/forms';
import { Button, Card, ErrorState, LoadingState, Modal, NoPermission, PageHeader, Select, formatMoney } from '@/components/ui';
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
  if (settings.isLoading) return <LoadingState />;
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
            {writable && <Button onClick={() => setCreating(true)}>{t('opps.new')}</Button>}
          </div>
        }
      />
      {opps.error ? (
        <ErrorState error={opps.error} onRetry={() => opps.refetch()} />
      ) : !pipeline || opps.isLoading ? (
        <LoadingState />
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
                  className={`flex w-64 shrink-0 flex-col rounded-xl border p-2 ${dragOver === s.id ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-ink-100/60'}`}
                >
                  <header className="px-2 pb-2 pt-1">
                    <h2 className="text-sm font-semibold">{s.name}</h2>
                    <p className="text-xs text-ink-500">{t('pipeline.total', { count: items.length, value: formatMoney(value, locale) })}</p>
                  </header>
                  <div className="flex min-h-16 flex-col gap-2">
                    {items.map((o) => (
                      <Card key={o.id} className="p-3">
                        <div draggable={writable} onDragStart={(e) => e.dataTransfer.setData('text/plain', o.id)} className={writable ? 'cursor-grab' : ''}>
                          <Link href={`/accounts/${o.accountId}`} className="block text-sm font-medium hover:underline">{o.accountName}</Link>
                          <p className="text-sm text-ink-700">{o.title}</p>
                          <p className="mt-1 text-xs text-ink-500">{formatMoney(o.amount, locale)} · {o.ownerName ?? t('common.unassigned')}</p>
                        </div>
                        {writable && (
                          <Button variant="ghost" className="mt-1 min-h-9 w-full px-2 text-xs" onClick={() => setMove({ opp: o })}>
                            {t('opps.moveTo')}
                          </Button>
                        )}
                      </Card>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          {opps.data!.length === 0 && <p className="mt-4 text-center text-sm text-ink-500">{t('pipeline.empty')}</p>}
        </div>
      )}
      <Modal open={!!move} onClose={() => setMove(null)} title={t('opps.moveTo')}>
        {move && pipeline && (
          <MoveStageForm
            opportunity={move.opp}
            pipeline={pipeline}
            targetStageId={move.stageId}
            onCancel={() => setMove(null)}
            onDone={() => {
              setMove(null);
              invalidate('opps');
            }}
          />
        )}
      </Modal>
      <Modal open={creating} onClose={() => setCreating(false)} title={t('opps.new')}>
        <OpportunityForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); invalidate('opps'); }} />
      </Modal>
    </>
  );
}
