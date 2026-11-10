'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AccountDto, Paged } from '@rakan/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AccountForm } from '@/components/crm/AccountForm';
import { Icon } from '@/components/icons';
import {
  Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Input, LoadingState, Modal, NoPermission, PageHeader, Pagination, Select, formatDate,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useCrmSettings, useMembers } from '@/lib/crm';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

export default function AccountsPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const router = useRouter();
  const settings = useCrmSettings();
  const members = useMembers();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState({ trackId: '', ownerMembershipId: '', status: '' });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (debounced) params.set('q', debounced);
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const list = useQuery({
    queryKey: ['accounts', params.toString()],
    queryFn: () => api<Paged<AccountDto>>(`/crm/accounts?${params}`),
    enabled: can('crm.account.read'),
    placeholderData: keepPreviousData,
  });

  if (!can('crm.account.read')) return <NoPermission />;
  const trackName = (id: string | null) => settings.data?.tracks.find((x) => x.id === id)?.name;
  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const exportParams = new URLSearchParams(params);
  exportParams.delete('page');
  exportParams.delete('pageSize');

  return (
    <>
      <PageHeader
        title={t('accounts.title')}
        subtitle={t('accounts.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {can('crm.import') && <ButtonLink href="/accounts/import" icon="upload">{t('common.import')}</ButtonLink>}
            {can('crm.export') && (
              <ButtonLink href={`/api/crm/accounts/export?format=xlsx&${exportParams}`} icon="download" download>{t('common.export')}</ButtonLink>
            )}
            {can('crm.account.write') && <Button icon="plus" onClick={() => setCreating(true)}>{t('accounts.new')}</Button>}
          </div>
        }
      />
      <Card>
        <div className="grid gap-3 border-b border-line-soft p-4 sm:grid-cols-4">
          <div className="sm:col-span-4 lg:col-span-1">
            <label htmlFor="acc-q" className="sr-only">{t('common.search')}</label>
            <div className="relative">
              <Icon name="search" size={16} className="pointer-events-none absolute inset-y-0 start-3 my-auto text-fg-muted" />
              <Input id="acc-q" type="search" className="ps-9" placeholder={t('accounts.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          {!!settings.data?.tracks.length && (
            <Select aria-label={t('accounts.track')} value={filters.trackId} onChange={(e) => setFilter('trackId', e.target.value)}>
              <option value="">{t('accounts.track')}: {t('common.all')}</option>
              {settings.data.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
            </Select>
          )}
          {can('team.member.read') && (
            <Select aria-label={t('accounts.owner')} value={filters.ownerMembershipId} onChange={(e) => setFilter('ownerMembershipId', e.target.value)}>
              <option value="">{t('accounts.owner')}: {t('common.all')}</option>
              <option value="me">{t('common.me')}</option>
              <option value="unassigned">{t('common.unassigned')}</option>
              {members.data?.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
            </Select>
          )}
          <Select aria-label={t('accounts.status')} value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">{t('accounts.status')}: {t('common.all')}</option>
            {(['active', 'customer', 'disqualified', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`accounts.status.${s}`)}</option>)}
          </Select>
        </div>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
        ) : list.data!.items.length === 0 ? (
          debounced || Object.values(filters).some(Boolean) ? (
            <EmptyState icon="search">{t('accounts.noMatch')}</EmptyState>
          ) : (
            <EmptyState
              icon="building"
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {can('crm.account.write') && <Button icon="plus" onClick={() => setCreating(true)}>{t('accounts.new')}</Button>}
                  {can('crm.import') && <ButtonLink href="/accounts/import" icon="upload">{t('common.import')}</ButtonLink>}
                </div>
              }
            >
              {t('accounts.empty')}
            </EmptyState>
          )
        ) : (
          <>
            <p className="px-4 pt-3 text-xs text-fg-muted">{t('common.resultsCount', { count: list.data!.total })}</p>
            <ul className="stagger divide-y divide-line-soft">
              {list.data!.items.map((a) => (
                <li key={a.id}>
                  <Link href={`/accounts/${a.id}`} className="group flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors duration-150 hover:bg-subtle">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-sm font-semibold text-brand-700" aria-hidden>{a.name.trim()[0]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.name}</p>
                      <p className="truncate text-sm text-fg-muted">
                        {[a.city, trackName(a.trackId), a.ownerName ?? t('common.unassigned')].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    {a.status !== 'active' && <Badge tone={a.status === 'customer' ? 'brand' : 'muted'}>{t(`accounts.status.${a.status}` as MessageKey)}</Badge>}
                    {!!a.openOpportunities && <Badge>{t('accounts.openOpps')}: {a.openOpportunities}</Badge>}
                    {a.lastActivityAt && <span className="text-xs text-fg-muted">{formatDate(a.lastActivityAt, locale)}</span>}
                    <Icon name="chevronEnd" size={16} className="text-fg-muted transition-transform duration-150 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
            <Pagination page={page} total={list.data!.total} pageSize={25} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title={t('accounts.new')} size="lg">
        <AccountForm onCancel={() => setCreating(false)} onSaved={(a) => router.push(`/accounts/${a.id}`)} />
      </Modal>
    </>
  );
}
