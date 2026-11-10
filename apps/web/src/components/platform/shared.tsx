'use client';

import type { TenantAdminDto } from '@rakan/shared';
import { Badge } from '@/components/ui';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/lib/providers';

export const STATUS_TONE: Record<string, 'brand' | 'success' | 'danger' | 'muted'> = { trial: 'brand', active: 'success', suspended: 'danger', cancelled: 'muted' };

export function AlertBadges({ alerts }: { alerts: TenantAdminDto['alerts'] }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap gap-1">
      {alerts.map((a) => (
        <Badge key={a.metric} tone={a.level === 'full' ? 'danger' : 'accent'}>{t(`platform.metric.${a.metric}` as MessageKey)} {a.level === 'full' ? '100%' : '80%+'}</Badge>
      ))}
    </span>
  );
}

