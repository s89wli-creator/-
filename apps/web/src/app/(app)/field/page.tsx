'use client';

import type { VisitDto } from '@rakan/shared';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Badge, EmptyState, ErrorState, LoadingState, NoPermission, PageHeader, formatDay, formatTime } from '@/components/ui';
import { directionsUrl, useFieldPack } from '@/lib/field';
import type { MessageKey } from '@/lib/i18n';
import { useCan, useI18n } from '@/lib/providers';

const STATUS_TONE = { scheduled: 'neutral', in_progress: 'warn', completed: 'success', cancelled: 'muted' } as const;
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

/** "My day": the rep's route for today and the next days, usable without a connection. */
export default function FieldPage() {
  const { t, locale } = useI18n();
  const can = useCan();
  const pack = useFieldPack();
  if (!can('crm.visit.read')) return <NoPermission />;
  if (pack.isLoading) return <LoadingState card rows={4} />;
  if (pack.error) return <ErrorState error={pack.error} onRetry={() => pack.refetch()} />;
  const p = pack.data!;
  const today = dayKey(new Date().toISOString());
  const groups = new Map<string, VisitDto[]>();
  for (const v of p.visits) groups.set(dayKey(v.scheduledStart), [...(groups.get(dayKey(v.scheduledStart)) ?? []), v]);
  const openTasks = p.tasks.filter((x) => x.status !== 'done');

  return (
    <>
      <PageHeader title={t('field.title')} subtitle={t('field.preparedAt', { time: formatTime(p.generatedAt, locale) })} />
      {p.visits.length === 0 ? (
        <EmptyState icon="pin" action={<Link href="/visits" className="text-brand-700 hover:underline">{t('field.allVisits')}</Link>}>{t('field.noVisits')}</EmptyState>
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([day, visits]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-semibold text-fg-sub">{day === today ? t('field.today') : formatDay(visits[0]!.scheduledStart, locale)}</h2>
              <ol className="stagger space-y-3">
                {visits.map((v, i) => {
                  const a = p.accounts[v.accountId];
                  const contact = a?.contacts.find((c) => c.isPrimary && !c.doNotContact) ?? a?.contacts.find((c) => !c.doNotContact && c.phone);
                  const maps = directionsUrl({ lat: a?.lat, lng: a?.lng, address: a?.address, city: a?.city ?? v.accountCity });
                  return (
                    <li key={v.id} className="rounded-xl border border-line bg-surface shadow-xs">
                      <Link href={`/visits/${v.id}`} className="flex items-start gap-3 p-4">
                        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-50 font-semibold text-brand-700">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center justify-between gap-2">
                            <span className="truncate font-semibold">{v.accountName}</span>
                            <Badge tone={STATUS_TONE[v.status]} dot>{t(`visits.status.${v.status}` as MessageKey)}</Badge>
                          </span>
                          <span className="mt-0.5 block text-sm text-fg-muted">
                            {formatTime(v.scheduledStart, locale)}{v.accountCity && ` · ${v.accountCity}`}{v.purpose && ` · ${v.purpose}`}
                          </span>
                          {p.briefs[v.id] && <span className="mt-1 inline-flex items-center gap-1 text-xs text-brand-700"><Icon name="sparkle" size={16} />{t('field.briefReady')}</span>}
                        </span>
                      </Link>
                      {(maps || contact?.phone) && (
                        <div className="flex border-t border-line-soft">
                          {maps && (
                            <a href={maps} target="_blank" rel="noopener noreferrer" className="flex min-h-11 flex-1 items-center justify-center gap-2 text-sm font-medium text-brand-700 hover:bg-subtle">
                              <Icon name="map" size={16} /> {t('field.directions')}
                            </a>
                          )}
                          {contact?.phone && (
                            <a href={`tel:${contact.phone}`} className="flex min-h-11 flex-1 items-center justify-center gap-2 border-s border-line-soft text-sm font-medium text-brand-700 hover:bg-subtle">
                              <Icon name="phone" size={16} /> {t('field.call', { name: contact.fullName })}
                            </a>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      {openTasks.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-fg-sub">{t('field.tasks', { n: openTasks.length })}</h2>
          <ul className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
            {openTasks.slice(0, 8).map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 truncate">{x.title}{x.accountName && <span className="text-fg-muted"> · {x.accountName}</span>}</span>
                {x.dueAt && <span className="shrink-0 text-xs text-fg-muted">{formatDay(x.dueAt, locale)}</span>}
              </li>
            ))}
          </ul>
          <Link href="/tasks" className="mt-2 inline-block text-sm text-brand-700 hover:underline">{t('field.allTasks')}</Link>
        </section>
      )}
    </>
  );
}
