'use client';

import { useQuery } from '@tanstack/react-query';
import type { ProposalDto } from '@rakan/shared';
import { use } from 'react';
import { ProposalDocument } from '@/components/proposals/ProposalDocument';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n, useMe } from '@/lib/providers';

/** Printable proposal (the browser's "Save as PDF" makes the PDF). No app chrome. */
export default function PrintProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const me = useMe();
  const q = useQuery({ queryKey: ['proposal', id], queryFn: () => api<ProposalDto>(`/crm/proposals/${id}`) });
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<{ settings: { logo?: { updatedAt: string } } }>('/tenant') });
  const logo = tenant.data?.settings?.logo;
  if (q.isLoading || me.isLoading || tenant.isLoading) return <div className="p-8"><LoadingState card /></div>;
  if (q.error) return <div className="p-8"><ErrorState error={q.error} /></div>;
  const p = q.data!;
  return (
    <div className="min-h-dvh bg-subtle py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-3xl justify-end gap-2 px-4 print:hidden">
        <Button icon="printer" onClick={() => window.print()}>{t('proposal.print')}</Button>
      </div>
      <ProposalDocument
        doc={{
          ...p, companyName: me.data?.activeTenant?.name ?? '', customerName: p.account.name, contactName: p.contact?.name ?? null,
          preparedBy: p.ownerName, sentAt: p.sentAt ?? p.updatedAt, logoUrl: logo ? `/api/tenant/logo?v=${encodeURIComponent(logo.updatedAt)}` : null,
        }}
      />
    </div>
  );
}
