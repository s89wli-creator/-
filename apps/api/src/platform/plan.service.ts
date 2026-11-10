import { Injectable } from '@nestjs/common';
import { plans, subscriptions, type PlanLimits, type Tx } from '@rakan/db';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../common/db.service';
import { AppError } from '../common/errors';

export const TRIAL_DAYS = 14;
export const DEFAULT_PLAN = 'team';

export interface TenantStats {
  activeUsers: number; pendingInvitations: number; accounts: number; visits30d: number;
  aiUsdMonth: number; aiRunsMonth: number; storageBytes: number; lastActivityAt: Date | null;
}

type StatsRow = {
  tenant_id: string; active_users: number; pending_invitations: number; accounts: number; visits_30d: number;
  ai_usd_month: string; ai_runs_month: number; storage_bytes: string; last_activity_at: Date | string | null;
};

export function mapStats(r: StatsRow): TenantStats {
  return {
    activeUsers: Number(r.active_users), pendingInvitations: Number(r.pending_invitations), accounts: Number(r.accounts), visits30d: Number(r.visits_30d),
    aiUsdMonth: Number(r.ai_usd_month), aiRunsMonth: Number(r.ai_runs_month), storageBytes: Number(r.storage_bytes),
    lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at) : null,
  };
}

/**
 * Plan limits, enforced where the resource is consumed (hard limits from day one):
 * users (invitations), monthly AI spend (caps the company's own budget), recording storage.
 * A null limit means unlimited (Enterprise).
 */
@Injectable()
export class PlanService {
  constructor(private readonly db: DbService) {}

  async planFor(tenantId: string): Promise<{ key: string; name: string; limits: PlanLimits; trialEndsAt: Date | null } | null> {
    const [r] = await this.db.platform((tx) =>
      tx
        .select({ key: plans.key, name: plans.nameAr, limits: plans.limits, trialEndsAt: subscriptions.trialEndsAt })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(eq(subscriptions.tenantId, tenantId)),
    );
    return r ?? null;
  }

  async limits(tenantId: string): Promise<PlanLimits> {
    return (await this.planFor(tenantId))?.limits ?? { users: null, aiMonthlyUsd: null, storageMb: null, recordingMinutes: null };
  }

  /** Aggregate usage (numbers only) via the SECURITY DEFINER function. */
  async stats(tenantId: string): Promise<TenantStats> {
    const r = await this.db.platform((tx) => tx.execute<StatsRow>(sql`SELECT * FROM platform_tenant_stats(${tenantId}::uuid)`));
    return mapStats(r.rows[0]!);
  }

  /** New company: default plan on a trial. Runs inside the registration transaction. */
  async startTrial(tx: Tx, tenantId: string): Promise<void> {
    const [p] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.key, DEFAULT_PLAN));
    if (p) await tx.insert(subscriptions).values({ tenantId, planId: p.id, trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86400_000) });
  }

  async assertCanAddUser(tenantId: string, countPending = true): Promise<void> {
    const { users } = await this.limits(tenantId);
    if (users === null) return;
    const s = await this.stats(tenantId);
    if (s.activeUsers + (countPending ? s.pendingInvitations : 0) >= users) {
      throw new AppError(409, 'PLAN_LIMIT_USERS', 'The plan user limit has been reached', { limit: users });
    }
  }

  async assertStorage(tenantId: string, addBytes: number): Promise<void> {
    const { storageMb } = await this.limits(tenantId);
    if (storageMb === null) return;
    const s = await this.stats(tenantId);
    const cap = storageMb * 1024 * 1024;
    // Starting a recording (addBytes = 0) is refused once the storage is already full.
    if (s.storageBytes + addBytes > cap || (addBytes === 0 && s.storageBytes >= cap)) {
      throw new AppError(409, 'PLAN_LIMIT_STORAGE', 'The plan storage limit has been reached', { limitMb: storageMb });
    }
  }

  /** Effective monthly AI budget: the company's own setting, never above the plan's cap. */
  async aiCap(tenantId: string): Promise<number | null> {
    return (await this.limits(tenantId)).aiMonthlyUsd;
  }
}
