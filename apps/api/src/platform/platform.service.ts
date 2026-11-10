import { Injectable } from '@nestjs/common';
import { memberships, plans, platformAudit, subscriptions, tenants, users } from '@rakan/db';
import type { PlanDto, PlatformAuditDto, PlatformOverviewDto, TenantAdminDto, TenantPlanDto, UsageDto } from '@rakan/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { AuthContext, RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService, pgConstraint, pgErrorCode } from '../common/db.service';
import { AppError, conflict, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { mapStats, PlanService, type TenantStats } from './plan.service';

type PlanRow = typeof plans.$inferSelect;

function usageDto(s: TenantStats): UsageDto {
  return { ...s, aiUsdMonth: Math.round(s.aiUsdMonth * 10000) / 10000, lastActivityAt: s.lastActivityAt?.toISOString() ?? null };
}

/** ≥ 80% of a limit = warn, ≥ 100% = full. Unlimited (null) never alerts. */
export function alertsFor(limits: PlanRow['limits'] | null, u: TenantStats): TenantAdminDto['alerts'] {
  if (!limits) return [];
  const out: TenantAdminDto['alerts'] = [];
  const check = (metric: 'users' | 'ai' | 'storage', used: number, limit: number | null) => {
    if (limit === null || limit <= 0) return;
    const r = used / limit;
    if (r >= 1) out.push({ metric, level: 'full' });
    else if (r >= 0.8) out.push({ metric, level: 'warn' });
  };
  check('users', u.activeUsers, limits.users);
  check('ai', u.aiUsdMonth, limits.aiMonthlyUsd);
  check('storage', u.storageBytes / (1024 * 1024), limits.storageMb);
  return out;
}

/**
 * Platform console (Rakan operators). Works only with company metadata, plans and aggregate numbers:
 * it never reads a company's customers, contacts, notes, visits content or AI outputs.
 * Every change is written to platform_audit and to the company's own audit log.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly db: DbService,
    private readonly planSvc: PlanService,
    private readonly audit: AuditService,
  ) {}

  private async allStats(): Promise<Map<string, TenantStats>> {
    const r = await this.db.platform((tx) => tx.execute(sql`SELECT * FROM platform_tenant_stats(NULL)`));
    return new Map((r.rows as Parameters<typeof mapStats>[0][]).map((x) => [x.tenant_id, mapStats(x)]));
  }

  private async rows(where?: ReturnType<typeof eq>) {
    return this.db.platform((tx) =>
      tx
        .select({ t: tenants, s: subscriptions, p: plans })
        .from(tenants)
        .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
        .leftJoin(plans, eq(plans.id, subscriptions.planId))
        .where(where)
        .orderBy(desc(tenants.createdAt)),
    );
  }

  /** Owner names/emails come from the platform tables (users), via a membership lookup per company. */
  private async owners(ids: string[]): Promise<Map<string, { name: string; email: string }>> {
    const out = new Map<string, { name: string; email: string }>();
    for (const id of ids) {
      const [o] = await this.db.run({ tenantId: id }, (tx) =>
        tx
          .select({ name: users.fullName, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.tenantId, id), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
          .orderBy(asc(memberships.createdAt))
          .limit(1),
      );
      if (o) out.set(id, o);
    }
    return out;
  }

  private dto(r: Awaited<ReturnType<PlatformService['rows']>>[number], stats: TenantStats, owner?: { name: string; email: string }): TenantAdminDto {
    const { t, s, p } = r;
    return {
      id: t.id, name: t.name, slug: t.slug, status: t.status, createdAt: t.createdAt.toISOString(),
      ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? null,
      plan: p ? { id: p.id, key: p.key, nameAr: p.nameAr, nameEn: p.nameEn, priceSarMonthly: p.priceSarMonthly, limits: p.limits } : null,
      trialEndsAt: s?.trialEndsAt?.toISOString() ?? null, currentPeriodEnd: s?.currentPeriodEnd?.toISOString() ?? null, notes: s?.notes ?? null,
      usage: usageDto(stats), alerts: alertsFor(p?.limits ?? null, stats),
    };
  }

  async tenants(q: { q?: string; status?: string }): Promise<TenantAdminDto[]> {
    const [rows, stats] = await Promise.all([this.rows(), this.allStats()]);
    const needle = q.q?.toLowerCase();
    const filtered = rows.filter((r) => (!q.status || r.t.status === q.status) && (!needle || r.t.name.toLowerCase().includes(needle) || r.t.slug.toLowerCase().includes(needle)));
    const owners = await this.owners(filtered.map((r) => r.t.id));
    return filtered.map((r) => this.dto(r, stats.get(r.t.id)!, owners.get(r.t.id)));
  }

  async tenant(id: string): Promise<TenantAdminDto & { recentActions: PlatformAuditDto[] }> {
    const [r] = await this.rows(eq(tenants.id, id));
    if (!r) throw notFound('Company');
    const owners = await this.owners([id]);
    return { ...this.dto(r, await this.planSvc.stats(id), owners.get(id)), recentActions: await this.auditLog(id) };
  }

  async overview(): Promise<PlatformOverviewDto> {
    const [rows, stats] = await Promise.all([this.rows(), this.allStats()]);
    const count = (st: string) => rows.filter((r) => r.t.status === st).length;
    const all = [...stats.values()];
    const now = Date.now();
    const byPlan = new Map<string, { key: string; nameAr: string; nameEn: string; tenants: number }>();
    let mrr = 0;
    let alerts = 0;
    for (const r of rows) {
      if (r.p) {
        const e = byPlan.get(r.p.key) ?? { key: r.p.key, nameAr: r.p.nameAr, nameEn: r.p.nameEn, tenants: 0 };
        e.tenants++;
        byPlan.set(r.p.key, e);
        if (r.t.status === 'active') mrr += r.p.priceSarMonthly ?? 0;
      }
      if (alertsFor(r.p?.limits ?? null, stats.get(r.t.id)!).length) alerts++;
    }
    return {
      tenants: {
        total: rows.length, trial: count('trial'), active: count('active'), suspended: count('suspended'), cancelled: count('cancelled'),
        new30d: rows.filter((r) => now - r.t.createdAt.getTime() < 30 * 86400_000).length,
      },
      users: all.reduce((a, s) => a + s.activeUsers, 0),
      mrrSar: mrr,
      aiUsdMonth: Math.round(all.reduce((a, s) => a + s.aiUsdMonth, 0) * 100) / 100,
      storageBytes: all.reduce((a, s) => a + s.storageBytes, 0),
      trialsEndingSoon: rows.filter((r) => r.t.status === 'trial' && r.s?.trialEndsAt && r.s.trialEndsAt.getTime() - now < 3 * 86400_000).length,
      alerts,
      byPlan: [...byPlan.values()],
      topAiSpend: rows
        .map((r) => ({ id: r.t.id, name: r.t.name, aiUsdMonth: Math.round(stats.get(r.t.id)!.aiUsdMonth * 100) / 100 }))
        .filter((x) => x.aiUsdMonth > 0)
        .sort((a, b) => b.aiUsdMonth - a.aiUsdMonth)
        .slice(0, 5),
    };
  }

  private async log(auth: AuthContext, action: string, tenantId: string | null, before: unknown, after: unknown, meta: RequestMeta): Promise<void> {
    await this.db.platform((tx) =>
      tx.insert(platformAudit).values({
        actorUserId: auth.userId, action, tenantId, before: before ?? null, after: after ?? null,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      }),
    );
    if (tenantId) {
      // The company also sees platform actions on its account in its own audit log.
      await this.db.run({ tenantId, userId: auth.userId }, (tx) =>
        this.audit.record(tx, { tenantId, actorType: 'system', actorUserId: auth.userId, action, entityType: 'tenant', entityId: tenantId, before, after, meta }),
      );
    }
  }

  async updateSubscription(
    auth: AuthContext,
    id: string,
    input: { planId?: string; status?: string; trialEndsAt?: string | null; currentPeriodEnd?: string | null; notes?: string | null; reason: string },
    meta: RequestMeta,
  ): Promise<TenantAdminDto & { recentActions: PlatformAuditDto[] }> {
    const before = await this.tenant(id);
    await this.db.platform(async (tx) => {
      if (input.planId) {
        const [p] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, input.planId));
        if (!p) throw new AppError(400, 'INVALID_REFERENCE', 'Unknown plan');
      }
      const values = {
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null } : {}),
        ...(input.currentPeriodEnd !== undefined ? { currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedBy: auth.userId, updatedAt: new Date(),
      };
      const planId = input.planId ?? before.plan?.id;
      if (!planId) throw new AppError(400, 'INVALID_REFERENCE', 'Choose a plan');
      await tx.insert(subscriptions).values({ tenantId: id, planId, ...values }).onConflictDoUpdate({ target: subscriptions.tenantId, set: values });
      if (input.status) await tx.update(tenants).set({ status: input.status, updatedAt: new Date() }).where(eq(tenants.id, id));
    });
    const after = await this.tenant(id);
    const pick = (x: TenantAdminDto) => ({ plan: x.plan?.key ?? null, status: x.status, trialEndsAt: x.trialEndsAt, currentPeriodEnd: x.currentPeriodEnd, notes: x.notes });
    await this.log(auth, 'platform.subscription.update', id, pick(before), { ...pick(after), reason: input.reason }, meta);
    return this.tenant(id);
  }

  // ---------------------------------------------------------------- plans

  async plans(): Promise<PlanDto[]> {
    return this.db.platform(async (tx) => {
      const rows = await tx.select().from(plans).orderBy(asc(plans.sort));
      const counts = await tx.select({ planId: subscriptions.planId, n: sql<number>`count(*)::int` }).from(subscriptions).groupBy(subscriptions.planId);
      return rows.map((p) => ({
        id: p.id, key: p.key, nameAr: p.nameAr, nameEn: p.nameEn, priceSarMonthly: p.priceSarMonthly, limits: p.limits, isActive: p.isActive, sort: p.sort,
        tenants: counts.find((c) => c.planId === p.id)?.n ?? 0,
      }));
    });
  }

  async createPlan(auth: AuthContext, input: Omit<PlanRow, 'id' | 'createdAt' | 'updatedAt'>, meta: RequestMeta): Promise<PlanDto[]> {
    try {
      await this.db.platform((tx) => tx.insert(plans).values(input));
    } catch (e) {
      if (pgErrorCode(e) === '23505' && pgConstraint(e) === 'plans_key_key') throw conflict('NAME_TAKEN', 'A plan with this key exists');
      throw e;
    }
    await this.log(auth, 'platform.plan.create', null, null, input, meta);
    return this.plans();
  }

  async updatePlan(auth: AuthContext, id: string, input: Partial<Omit<PlanRow, 'id' | 'key' | 'createdAt' | 'updatedAt'>>, meta: RequestMeta): Promise<PlanDto[]> {
    const before = await this.db.platform(async (tx) => {
      const [p] = await tx.select().from(plans).where(eq(plans.id, id));
      if (!p) throw notFound('Plan');
      await tx.update(plans).set({ ...input, updatedAt: new Date() }).where(eq(plans.id, id));
      return p;
    });
    await this.log(auth, 'platform.plan.update', null, { key: before.key, priceSarMonthly: before.priceSarMonthly, limits: before.limits, isActive: before.isActive }, input, meta);
    return this.plans();
  }

  async auditLog(tenantId?: string): Promise<PlatformAuditDto[]> {
    return this.db.platform(async (tx) => {
      const rows = await tx
        .select({ a: platformAudit, actor: users.fullName, tenant: tenants.name })
        .from(platformAudit)
        .leftJoin(users, eq(users.id, platformAudit.actorUserId))
        .leftJoin(tenants, eq(tenants.id, platformAudit.tenantId))
        .where(tenantId ? eq(platformAudit.tenantId, tenantId) : undefined)
        .orderBy(desc(platformAudit.id))
        .limit(200);
      return rows.map(({ a, actor, tenant }) => ({
        id: a.id, action: a.action, actorName: actor, tenantId: a.tenantId, tenantName: tenant, before: a.before, after: a.after, createdAt: a.createdAt.toISOString(),
      }));
    });
  }

  // ---------------------------------------------------------------- the company's own view

  async ownPlan(auth: TenantAuthContext): Promise<TenantPlanDto> {
    const t = await this.tenant(auth.tenantId);
    const { plan, status, trialEndsAt, usage, alerts } = t;
    return { plan: plan && { key: plan.key, nameAr: plan.nameAr, nameEn: plan.nameEn, priceSarMonthly: plan.priceSarMonthly, limits: plan.limits }, status, trialEndsAt, usage, alerts };
  }
}
