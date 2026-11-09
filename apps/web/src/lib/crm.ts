'use client';

import { useQuery } from '@tanstack/react-query';
import type { CrmSettingsDto, MemberDto } from '@rakan/shared';
import { api } from './api';
import { useCan } from './providers';

export function useCrmSettings() {
  const can = useCan();
  return useQuery({ queryKey: ['crm-settings'], queryFn: () => api<CrmSettingsDto>('/crm/settings'), enabled: can('crm.account.read'), staleTime: 60_000 });
}

/** Active members for owner/assignee pickers (only for roles allowed to read the team). */
export function useMembers() {
  const can = useCan();
  return useQuery({
    queryKey: ['members'],
    queryFn: () => api<MemberDto[]>('/team/members'),
    enabled: can('team.member.read'),
    // Pickers must include people who just joined (e.g. an invitation accepted minutes ago).
    refetchOnMount: 'always',
    select: (rows) => rows.filter((m) => m.status === 'active'),
  });
}

export function isoDaysFromNow(days: number, hour = 9): string {
  const d = new Date(Date.now() + days * 86400_000);
  // 09:00 Riyadh time on that day
  const riyadh = new Date(d.getTime() + 3 * 3600_000);
  return new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), riyadh.getUTCDate(), hour - 3)).toISOString();
}

/** Start (Saturday 00:00 Riyadh) of the week containing `date`, as a Date in UTC. */
export function weekStart(date = new Date()): Date {
  const riyadh = new Date(date.getTime() + 3 * 3600_000);
  const day = riyadh.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 1) % 7; // days since Saturday
  return new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), riyadh.getUTCDate() - diff) - 3 * 3600_000);
}
