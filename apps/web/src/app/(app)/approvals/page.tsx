'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { ApprovalDto } from '@rakan/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useToast } from '@/components/feedback';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, Modal, NoPermission, PageHeader, Tabs, Textarea, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage, type MessageKey } from '@/lib/i18n';
import { useCan, useI18n, useInvalidate } from '@/lib/providers';

type View = 'pending' | 'history';
const STATUS_TONE: Record<string, 'warn' | 'success' | 'danger' | 'muted' | 'brand' | 'accent'> = {
  pending: 'accent', approved: 'brand', executed: 'success', rejected: 'danger', expired: 'muted', execution_failed: 'danger',
};

/** What exactly will happen if approved: shown verbatim from the stored payload. */
function PayloadPreview({ a }: { a: ApprovalDto }) {
  const { t } = useI18n();
  const p = a.payload as { subject?: string | null; body?: string; channel?: string };
  if (a.actionType === 'send_message') {
    return (
      <div className="rounded-lg border border-line bg-subtle p-4 text-sm">
        <p className="mb-1 text-xs text-fg-muted">{t(`ai.channel.${p.channel ?? 'email'}` as MessageKey)}</p>
        {p.subject && <p className="mb-2 font-semibold">{p.subject}</p>}
        <p className="whitespace-pre-wrap">{p.body}</p>
      </div>
    );
  }
  return <pre className="overflow-x-auto rounded-lg bg-subtle p-3 text-xs" dir="ltr">{JSON.stringify(a.payload, null, 2)}</pre>;
}

export default function ApprovalsPage() {
  const { t, err, locale } = useI18n();
  const can = useCan();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [view, setView] = useState<View>('pending');
  const [rejecting, setRejecting] = useState<ApprovalDto | null>(null);
  const list = useQuery({
    queryKey: ['approvals', view],
    queryFn: () => api<ApprovalDto[]>(view === 'pending' ? '/approvals?status=pending' : '/approvals'),
    enabled: can('approvals.decide'),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: 'approve' | 'reject'; note?: string }) =>
      api<ApprovalDto>(`/approvals/${id}/decision`, { method: 'POST', body: { decision, note } }),
    onSuccess: (r) => {
      setRejecting(null);
      invalidate('approvals');
      toast(t(r.status === 'executed' ? 'approvals.executed' : r.status === 'rejected' ? 'approvals.rejected' : 'approvals.failed'), r.status === 'execution_failed' ? 'error' : undefined);
    },
  });

  if (!can('approvals.decide')) return <NoPermission />;
  const items = view === 'pending' ? list.data : list.data?.filter((a) => a.status !== 'pending');

  return (
    <>
      <PageHeader title={t('approvals.title')} subtitle={t('approvals.subtitle')} />
      <Tabs<View> tabs={[{ id: 'pending', label: t('approvals.pending') }, { id: 'history', label: t('approvals.history') }]} value={view} onChange={setView} label={t('approvals.title')} />
      {decide.error && <div className="mb-3"><Alert tone="error">{err(decide.error)}</Alert></div>}
      {list.isLoading ? <LoadingState card /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !items?.length ? (
        <EmptyState icon="checkCircle">{t(view === 'pending' ? 'approvals.empty' : 'approvals.emptyHistory')}</EmptyState>
      ) : (
        <ul className="stagger space-y-3">
          {items.map((a) => (
            <li key={a.id}>
              <Card className="space-y-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">{a.summary ?? a.actionType}</h3>
                    <p className="text-sm text-fg-muted">
                      {t(a.requestedByType === 'agent' ? 'approvals.byAgent' : 'approvals.byUser', { name: a.requestedByName ?? '—' })} · {formatDate(a.createdAt, locale, true)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="danger">{t(`approvals.risk.${a.risk}` as MessageKey)}</Badge>
                    <Badge tone={STATUS_TONE[a.status] ?? 'muted'} dot>{t(`approvals.status.${a.status}` as MessageKey)}</Badge>
                  </div>
                </div>
                <PayloadPreview a={a} />
                {a.reason && <p className="text-sm"><span className="text-fg-muted">{t('approvals.reason')}:</span> {a.reason}</p>}
                {a.entityType === 'account' && a.entityId && <Link href={`/accounts/${a.entityId}`} className="text-sm text-brand-700 hover:underline">{t('approvals.openAccount')}</Link>}
                {a.status === 'pending' ? (
                  <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-3 sm:flex-row sm:justify-end">
                    <Button variant="danger" onClick={() => { decide.reset(); setRejecting(a); }}>{t('approvals.reject')}</Button>
                    <Button icon="check" loading={decide.isPending && decide.variables?.id === a.id && decide.variables.decision === 'approve'} onClick={() => decide.mutate({ id: a.id, decision: 'approve' })}>
                      {t(a.actionType === 'send_message' ? 'approvals.approveSend' : 'approvals.approve')}
                    </Button>
                  </div>
                ) : (
                  <p className="border-t border-line-soft pt-3 text-sm text-fg-muted">
                    {a.decidedByName && t('approvals.decidedBy', { name: a.decidedByName })}
                    {a.decidedAt && ` · ${formatDate(a.decidedAt, locale, true)}`}
                    {a.decisionNote && ` — ${a.decisionNote}`}
                    {a.status === 'execution_failed' && (a.executionResult as { code?: string } | null)?.code && <> · <span className="text-danger">{errorMessage(locale, (a.executionResult as { code: string }).code)}</span></>}
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title={t('approvals.reject')}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
            decide.mutate({ id: rejecting!.id, decision: 'reject', note: note || undefined });
          }}
        >
          <Field label={t('approvals.rejectNote')} htmlFor="rej-note" optional>
            <Textarea id="rej-note" name="note" rows={3} maxLength={1000} />
          </Field>
          <Button type="submit" variant="danger-solid" className="w-full" loading={decide.isPending}>{t('approvals.reject')}</Button>
        </form>
      </Modal>
    </>
  );
}
