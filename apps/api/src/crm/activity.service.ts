import { Injectable } from '@nestjs/common';
import { accounts, activities, type Tx } from '@rakan/db';
import { and, eq } from 'drizzle-orm';

export interface ActivityEntry {
  tenantId: string;
  accountId: string;
  opportunityId?: string | null;
  type: string;
  actorType?: 'user' | 'agent' | 'system';
  actorUserId?: string | null;
  refType?: string;
  refId?: string | null;
  summary?: string | null;
}

/** Unified customer timeline (append-only). Also bumps the account's last activity time. */
@Injectable()
export class ActivityService {
  async record(tx: Tx, e: ActivityEntry): Promise<void> {
    await tx.insert(activities).values({
      tenantId: e.tenantId,
      accountId: e.accountId,
      opportunityId: e.opportunityId ?? null,
      type: e.type,
      actorType: e.actorType ?? 'user',
      actorUserId: e.actorUserId ?? null,
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      summary: e.summary?.slice(0, 500) ?? null,
    });
    await tx
      .update(accounts)
      .set({ lastActivityAt: new Date() })
      .where(and(eq(accounts.tenantId, e.tenantId), eq(accounts.id, e.accountId)));
  }
}
