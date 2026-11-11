'use client';

import { useQuery } from '@tanstack/react-query';
import { PROPOSAL_STATUSES, type ProposalStatusKey, type ProposalSummaryDto } from '@rakan/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { NewProposalModal } from '@/components/proposals/NewProposal';
import { STATUS_TONE, money } from '@/components/proposals/ProposalDocument';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, NoPermission, PageHeader, Tabs, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useI18n } from '@/lib/providers';

type View = 'all' | ProposalStatusKey;

function ProposalsList() {
  const { t, locale } = useI18n();
  const can = useCan();
  const params = useSearchParams();
  const [view, setView] = useState<View>('all');
  const [creating, setCreating] = useState(params.get('new') === '1');
  const q = useQuery({
    queryKey: ['proposals', view],
    queryFn: () => api<ProposalSummaryDto[]>(`/crm/proposals${view === 'all' ? '' : `?status=${view}`}`),
    enabled: can('crm.proposal.read'),
  });
  if (!can('crm.proposal.read')) return <NoPermission />;
  return (
    <>
      <PageHeader title={t('proposal.title')} subtitle={t('proposal.subtitle')}
        actions={can('crm.proposal.write') && <Button icon="plus" onClick={() => setCreating(true)}>{t('proposal.new')}</Button>} />
      <Tabs<View>
        tabs={(['all', ...PROPOSAL_STATUSES.filter((s) => s !== 'cancelled')] as View[]).map((v) => ({ id: v, label: v === 'all' ? t('proposal.all') : t(`proposal.status.${v}`) }))}
        value={view} onChange={setView} label={t('proposal.title')}
      />
      {q.isLoading ? <LoadingState card /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.length ? (
        <EmptyState icon="file">{t('proposal.empty')}</EmptyState>
      ) : (
        <Card>
          <ul className="stagger divide-y divide-line-soft">
            {q.data!.map((p) => (
              <li key={p.id}>
                <Link href={`/proposals/${p.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 transition-colors hover:bg-subtle">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.title}</span>
                    <span className="block text-sm text-fg-muted"><span dir="ltr">{p.number}</span> · {p.account.name}{p.ownerName ? ` · ${p.ownerName}` : ''}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {p.expired && <Badge tone="warn">{t('proposal.expired')}</Badge>}
                    {p.viewedAt && p.status === 'sent' && <Badge tone="neutral">{t('proposal.viewed')}</Badge>}
                    <Badge tone={STATUS_TONE[p.status]} dot>{t(`proposal.status.${p.status}`)}</Badge>
                  </span>
                  <span className="w-full text-sm sm:w-40 sm:text-end">
                    <span className="block font-semibold tabular-nums">{money(p.total, p.currency, locale)}</span>
                    <span className="block text-xs text-fg-muted">{formatDate(p.updatedAt, locale)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {creating && <NewProposalModal open onClose={() => setCreating(false)} accountId={params.get('accountId') ?? undefined} />}
    </>
  );
}

export default function ProposalsPage() {
  return <Suspense fallback={<LoadingState card />}><ProposalsList /></Suspense>;
}
