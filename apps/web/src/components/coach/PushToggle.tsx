'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { PushConfigDto } from '@rakan/shared';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icons';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/providers';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';

/** Turns push alerts on or off for this device (the person's own choice, per device). */
export function PushToggle() {
  const { t } = useI18n();
  const cfg = useQuery({ queryKey: ['push'], queryFn: () => api<PushConfigDto>('/push') });
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    if (cfg.data) void pushState(cfg.data).then(setState);
  }, [cfg.data]);
  const toggle = useMutation({
    mutationFn: async () => {
      if (state === 'on') {
        await disablePush();
        return 'off' as PushState;
      }
      return enablePush(cfg.data!);
    },
    onSuccess: (s) => { setState(s); void cfg.refetch(); },
  });
  if (!state) return null;
  const note = state === 'denied' ? t('push.denied') : state === 'unsupported' ? t('push.unsupported') : state === 'not_configured' ? t('push.notConfigured') : t('push.privacy');
  return (
    <div className="space-y-1.5 border-t border-line-soft px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium"><Icon name="bell" size={16} /> {state === 'on' ? t('push.on') : t('push.title')}</p>
        {(state === 'on' || state === 'off') && (
          <Button variant={state === 'on' ? 'ghost' : 'secondary'} className="min-h-9" loading={toggle.isPending} onClick={() => toggle.mutate()}>
            {state === 'on' ? t('push.disable') : t('push.enable')}
          </Button>
        )}
      </div>
      <p className="text-xs text-fg-muted">{note}</p>
    </div>
  );
}
