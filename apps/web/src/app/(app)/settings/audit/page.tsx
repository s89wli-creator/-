'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditLogDto, MemberDto } from '@rakan/shared';
import { useState } from 'react';
import { Button, Card, EmptyState, ErrorState, LoadingState, NoPermission, PageHeader, Select, formatDate } from '@/components/ui';
import { api } from '@/lib/api';
import { AUDIT_ACTION_KEYS, AUDIT_HIDDEN_FIELDS, auditActionLabel, auditFieldLabel, type MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

interface Page {
  items: AuditLogDto[];
  nextCursor: number | null;
}

/** Flattens one level of nesting (settings.x) so each changed setting shows as its own line. */
function flatten(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries((v ?? {}) as Record<string, unknown>)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k2, v2] of Object.entries(val as Record<string, unknown>)) out[`${k}.${k2}`] = v2;
    } else out[k] = val;
  }
  return out;
}

function Diff({ before, after, memberName }: { before: unknown; after: unknown; memberName: (id: string) => string | undefined }) {
  const { locale, t } = useI18n();
  const b = flatten(before);
  const a = flatten(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
    (k) => !AUDIT_HIDDEN_FIELDS.has(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]),
  );
  if (!keys.length) return null;
  const fmt = (k: string, v: unknown): string => {
    if (v === undefined || v === null || v === '') return '—';
    if (k === 'memberIds' && Array.isArray(v)) return v.length ? v.map((id) => memberName(String(id)) ?? '—').join('، ') : '—';
    if (k === 'role' && typeof v === 'string') return t(`role.${v}` as MessageKey);
    if (k === 'status' && (v === 'active' || v === 'disabled')) return t(`status.${v}`);
    if (k === 'settings.repVisibility' && (v === 'all' || v === 'assigned_only')) return t(`company.repVisibility.${v}`);
    if (typeof v === 'boolean') return locale === 'ar' ? (v ? 'نعم' : 'لا') : v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.length ? v.join('، ') : '—';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  return (
    <dl className="mt-2 space-y-1 text-xs">
      {keys.map((k) => (
        <div key={k} className="flex flex-wrap items-baseline gap-x-2">
          <dt className="font-medium text-fg-sub">{auditFieldLabel(locale, k)}:</dt>
          {k in b && <dd className="text-danger line-through"><bdi>{fmt(k, b[k])}</bdi></dd>}
          {k in b && k in a && <dd aria-hidden className="text-fg-muted">←</dd>}
          {k in a && <dd className="text-brand-700"><bdi>{fmt(k, a[k])}</bdi></dd>}
        </div>
      ))}
    </dl>
  );
}

export default function AuditPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', action],
    enabled: can('audit.read'),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<Page>(`/audit-logs?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<MemberDto[]>('/team/members'), enabled: can('team.member.read') });
  const memberName = (id: string) => members.data?.find((m) => m.id === id)?.fullName;

  if (!can('audit.read')) return <NoPermission />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
        actions={
          <div className="w-56">
            <label htmlFor="audit-filter" className="sr-only">{t('audit.action')}</label>
            <Select id="audit-filter" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">{t('audit.filterAll')}</option>
              {AUDIT_ACTION_KEYS.map((k) => <option key={k} value={k}>{auditActionLabel(locale, k)}</option>)}
            </Select>
          </div>
        }
      />
      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <div className="p-4"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
        ) : items.length === 0 ? (
          <EmptyState>{t('audit.empty')}</EmptyState>
        ) : (
          <ol className="stagger divide-y divide-line-soft">
            {items.map((i) => (
              <li key={i.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{auditActionLabel(locale, i.action)}</p>
                  <time className="text-xs text-fg-muted" dateTime={i.createdAt}>{formatDate(i.createdAt, locale, true)}</time>
                </div>
                <p className="text-sm text-fg-muted">
                  {i.actorName ?? t('audit.system')}
                  {i.ip && (
                    <span className="text-xs"> · <bdi>{i.ip}</bdi></span>
                  )}
                </p>
                <Diff before={i.before} after={i.after} memberName={memberName} />
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line-soft p-4 text-center">
            <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t('audit.loadMore')}</Button>
          </div>
        )}
      </Card>
    </>
  );
}
