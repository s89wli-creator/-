'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContactDto, OpportunityDto, ProposalDto } from '@rakan/shared';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AiNotice, useAiStatus } from '@/components/ai/panels';
import { AccountPicker } from '@/components/crm/forms';
import { Alert, Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan, useI18n } from '@/lib/providers';

/** New proposal: prepared by hand, or drafted by Rakan from the approved price list. */
export function NewProposalModal({ open, onClose, accountId: fixedAccount }: { open: boolean; onClose: () => void; accountId?: string }) {
  const { t, err } = useI18n();
  const can = useCan();
  const router = useRouter();
  const ai = useAiStatus();
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [accountId, setAccountId] = useState(fixedAccount ?? '');
  const contacts = useQuery({ queryKey: ['contacts', accountId], queryFn: () => api<ContactDto[]>(`/crm/accounts/${accountId}/contacts`), enabled: !!accountId });
  const opps = useQuery({ queryKey: ['account-opps', accountId], queryFn: () => api<OpportunityDto[]>(`/crm/opportunities?accountId=${accountId}`), enabled: !!accountId });
  const create = useMutation({
    mutationFn: (v: { path: string; body: object }) => api<ProposalDto>(v.path, { method: 'POST', body: v.body }),
    onSuccess: (p) => {
      onClose();
      router.push(`/proposals/${p.id}${p.unmatchedNeeds?.length ? `?unmatched=${encodeURIComponent(JSON.stringify(p.unmatchedNeeds))}` : ''}`);
    },
  });
  const aiReady = !!ai.data?.available && !!ai.data.agents?.proposal?.enabled && can('ai.use');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const opt = (k: string) => String(fd.get(k) ?? '') || undefined;
    const base = { accountId, contactId: opt('contactId'), opportunityId: opt('opportunityId') };
    if (mode === 'ai') create.mutate({ path: '/crm/proposals/ai-draft', body: { ...base, request: String(fd.get('request') ?? '') } });
    else create.mutate({ path: '/crm/proposals', body: { ...base, title: String(fd.get('title') ?? '') } });
  }

  return (
    <Modal open={open} onClose={onClose} title={t('proposal.new')}>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-subtle-strong p-1" role="radiogroup" aria-label={t('proposal.new')}>
        {(['manual', 'ai'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { create.reset(); setMode(m); }}
            className={`min-h-9 rounded-md text-sm transition-colors ${mode === m ? 'bg-surface font-medium text-fg shadow-xs' : 'text-fg-muted hover:text-fg'}`}>
            {t(`proposal.mode.${m}`)}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-4">
        {create.error && <Alert tone="error">{err(create.error)}</Alert>}
        {!fixedAccount && <Field label={t('proposal.account')} htmlFor="accountId"><AccountPicker name="accountId" onChange={setAccountId} /></Field>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('proposal.contact')} htmlFor="contactId">
            <Select id="contactId" name="contactId" disabled={!accountId}>
              <option value="">{t('proposal.noContact')}</option>
              {contacts.data?.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </Select>
          </Field>
          <Field label={t('proposal.opportunity')} htmlFor="opportunityId">
            <Select id="opportunityId" name="opportunityId" disabled={!accountId}>
              <option value="">{t('proposal.none')}</option>
              {opps.data?.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </Select>
          </Field>
        </div>
        {mode === 'manual' ? (
          <Field label={t('proposal.name')} htmlFor="title"><Input id="title" name="title" required minLength={2} maxLength={200} /></Field>
        ) : (
          <>
            <AiNotice status={ai.data} />
            <Field label={t('proposal.request')} htmlFor="request"><Textarea id="request" name="request" rows={4} required minLength={5} maxLength={2000} placeholder={t('proposal.requestHint')} /></Field>
            <p className="text-xs text-fg-muted">{t('proposal.aiNote')}</p>
          </>
        )}
        <Button type="submit" icon={mode === 'ai' ? 'sparkle' : 'plus'} className="w-full" loading={create.isPending} disabled={!accountId || (mode === 'ai' && !aiReady)}>
          {t('proposal.create')}
        </Button>
      </form>
    </Modal>
  );
}
