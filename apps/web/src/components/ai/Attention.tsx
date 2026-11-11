'use client';

import { useQuery } from '@tanstack/react-query';
import type { AttentionItemDto } from '@rakan/shared';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { Badge, Card, EmptyState, LoadingState, SectionTitle, formatMoney } from '@/components/ui';
import { api } from '@/lib/api';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

const ICON: Record<AttentionItemDto['type'], IconName> = {
  hot_lead_untouched: 'sparkle', stale_deal: 'kanban', visit_without_follow_up: 'pin', overdue_task: 'checkSquare',
};

/** "Needs attention": neglected customers and loose ends, with the reason and the next step. */
export function AttentionCard({ limit = 6 }: { limit?: number }) {
  const { t, locale } = useI18n();
  const can = useCan();
  const q = useQuery({ queryKey: ['attention'], queryFn: () => api<AttentionItemDto[]>('/crm/attention'), enabled: can('crm.account.read') });
  if (!can('crm.account.read')) return null;
  const items = q.data ?? [];
  return (
    <Card>
      <SectionTitle action={items.length > 0 && <Badge tone="accent">{items.length}</Badge>}>{t('attention.title')}</SectionTitle>
      {q.isLoading ? <div className="p-5"><LoadingState rows={3} /></div> : !items.length ? (
        <EmptyState icon="checkCircle">{t('attention.empty')}</EmptyState>
      ) : (
        <ul className="stagger divide-y divide-line-soft">
          {items.slice(0, limit).map((x) => (
            <li key={`${x.type}-${x.refId}`}>
              <Link href={x.type === 'overdue_task' && !x.accountId ? '/tasks' : x.type === 'visit_without_follow_up' ? `/visits/${x.refId}` : `/accounts/${x.accountId}`} className="flex items-start gap-3 px-5 py-3 transition-colors duration-150 hover:bg-subtle">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-warn" aria-hidden><Icon name={ICON[x.type]} size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{x.accountName ?? x.detail}</span>
                  <span className="block text-sm text-fg-muted">
                    {t(`attention.type.${x.type}` as MessageKey, { days: x.days ?? '—', detail: x.detail })}
                    {x.amount ? ` · ${formatMoney(x.amount, locale)}` : ''}
                  </span>
                  <span className="mt-0.5 block text-xs text-brand-700">{t(`attention.do.${x.suggestion}` as MessageKey)}</span>
                </span>
                {x.ownerName && <span className="hidden shrink-0 text-xs text-fg-muted sm:block">{x.ownerName}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
