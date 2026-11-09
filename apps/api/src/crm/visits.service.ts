import { Injectable } from '@nestjs/common';
import { accounts, memberships, users, visits, type Tx } from '@rakan/db';
import type { VisitDto, VisitInput, VisitOutcomeInput } from '@rakan/shared';
import { and, asc, eq, gte, lt, type SQL } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, forbidden, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from './accounts.service';
import { ActivityService } from './activity.service';
import { OpportunitiesService } from './opportunities.service';
import { ScopeService, type RecordScope } from './scope';
import { TasksService } from './tasks.service';

type VisitRow = typeof visits.$inferSelect;

const FOLLOW_UP_TITLE: Record<string, { title: string; type: string }> = {
  send_proposal: { title: 'إرسال العرض التجاري', type: 'send_proposal' },
  another_visit: { title: 'ترتيب زيارة متابعة', type: 'meeting' },
  call: { title: 'اتصال متابعة', type: 'call' },
  none: { title: 'متابعة العميل', type: 'follow_up' },
};

@Injectable()
export class VisitsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly activity: ActivityService,
    private readonly accountsSvc: AccountsService,
    private readonly opps: OpportunitiesService,
    private readonly tasksSvc: TasksService,
  ) {}

  private async dtos(tx: Tx, tenantId: string, where: SQL): Promise<VisitDto[]> {
    const rows = await tx
      .select({ v: visits, accountName: accounts.name, accountCity: accounts.city, repName: users.fullName })
      .from(visits)
      .innerJoin(accounts, and(eq(accounts.tenantId, visits.tenantId), eq(accounts.id, visits.accountId)))
      .leftJoin(memberships, and(eq(memberships.tenantId, visits.tenantId), eq(memberships.id, visits.repMembershipId)))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(visits.tenantId, tenantId), where))
      .orderBy(asc(visits.scheduledStart))
      .limit(1000);
    return rows.map(({ v, accountName, accountCity, repName }) => ({
      id: v.id, accountId: v.accountId, accountName, accountCity, opportunityId: v.opportunityId, repMembershipId: v.repMembershipId,
      repName: repName ?? null, purpose: v.purpose, scheduledStart: v.scheduledStart.toISOString(), scheduledEnd: v.scheduledEnd?.toISOString() ?? null,
      status: v.status, checkInAt: v.checkInAt?.toISOString() ?? null, checkOutAt: v.checkOutAt?.toISOString() ?? null,
      checkInLat: v.checkInLat, checkInLng: v.checkInLng, outcome: v.outcome, interestLevel: v.interestLevel, nextStep: v.nextStep,
      nextFollowUpAt: v.nextFollowUpAt?.toISOString() ?? null, notes: v.notes, followUpTaskId: v.followUpTaskId, createdAt: v.createdAt.toISOString(),
    }));
  }

  private async one(tx: Tx, tenantId: string, id: string): Promise<VisitDto> {
    return (await this.dtos(tx, tenantId, eq(visits.id, id)))[0]!;
  }

  private async load(tx: Tx, auth: TenantAuthContext, scope: RecordScope, id: string, write = false): Promise<VisitRow> {
    const [v] = await tx.select().from(visits).where(and(eq(visits.tenantId, auth.tenantId), eq(visits.id, id)));
    if (!v) throw notFound('Visit');
    if (scope.restricted && v.repMembershipId !== scope.membershipId) {
      // Reps act only on their own visits; with read-all they may view others' but not change them.
      if (write || !scope.readAll) throw notFound('Visit');
    }
    return v;
  }

  list(auth: TenantAuthContext, q: { from: Date; to: Date; repMembershipId?: string; accountId?: string }): Promise<VisitDto[]> {
    if (q.to <= q.from || q.to.getTime() - q.from.getTime() > 92 * 86400_000) throw badRequest('INVALID_RANGE', 'Range must be positive and at most 92 days');
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const where: SQL[] = [gte(visits.scheduledStart, q.from), lt(visits.scheduledStart, q.to)];
      if (scope.restricted) where.push(eq(visits.repMembershipId, auth.membershipId));
      else if (q.repMembershipId) where.push(eq(visits.repMembershipId, q.repMembershipId));
      if (q.accountId) {
        await this.accountsSvc.loadAccount(tx, auth, scope, q.accountId);
        where.push(eq(visits.accountId, q.accountId));
      }
      return this.dtos(tx, auth.tenantId, and(...where)!);
    });
  }

  get(auth: TenantAuthContext, id: string): Promise<VisitDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.load(tx, auth, scope, id);
      return this.one(tx, auth.tenantId, id);
    });
  }

  private async checkRep(tx: Tx, auth: TenantAuthContext, scope: RecordScope, repMembershipId: string): Promise<void> {
    if (scope.restricted && repMembershipId !== auth.membershipId) throw forbidden('Reps can only schedule their own visits');
    const [m] = await tx.select({ id: memberships.id }).from(memberships)
      .where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, repMembershipId), eq(memberships.status, 'active')));
    if (!m) throw badRequest('INVALID_REFERENCE', 'Unknown rep', [{ path: 'repMembershipId', message: 'Unknown member', code: 'invalid_reference' }]);
  }

  create(auth: TenantAuthContext, input: VisitInput, meta: RequestMeta): Promise<VisitDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const account = await this.accountsSvc.loadAccount(tx, auth, scope, input.accountId, true);
      const rep = input.repMembershipId ?? account.ownerMembershipId ?? auth.membershipId;
      await this.checkRep(tx, auth, scope, rep);
      if (input.opportunityId) {
        const o = await this.opps.loadOpp(tx, auth, scope, input.opportunityId, true);
        if (o.accountId !== account.id) throw badRequest('INVALID_REFERENCE', 'Opportunity belongs to another account');
      }
      const [v] = await tx
        .insert(visits)
        .values({
          tenantId: auth.tenantId, accountId: account.id, opportunityId: input.opportunityId ?? null, repMembershipId: rep,
          purpose: input.purpose ?? null, scheduledStart: new Date(input.scheduledStart), scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : null,
          createdBy: auth.userId,
        })
        .returning();
      await this.activity.record(tx, { tenantId: auth.tenantId, accountId: account.id, opportunityId: v!.opportunityId, type: 'visit_scheduled', actorUserId: auth.userId, refType: 'visit', refId: v!.id, summary: input.purpose ?? null });
      if (v!.opportunityId) await this.opps.advanceOnEvent(tx, auth, v!.opportunityId, 'visit_scheduled', { visitId: v!.id, event: 'visit_scheduled' });
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'visit.create', entityType: 'visit', entityId: v!.id, after: { accountId: account.id, repMembershipId: rep, scheduledStart: input.scheduledStart }, meta });
      return this.one(tx, auth.tenantId, v!.id);
    });
  }

  reschedule(auth: TenantAuthContext, id: string, input: { scheduledStart: string; scheduledEnd?: string | null; repMembershipId?: string; purpose?: string | null }, meta: RequestMeta): Promise<VisitDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const v = await this.load(tx, auth, scope, id, true);
      if (v.status !== 'scheduled') throw new AppError(409, 'INVALID_STATE', 'Only scheduled visits can be rescheduled');
      if (input.repMembershipId) await this.checkRep(tx, auth, scope, input.repMembershipId);
      if (input.scheduledEnd && input.scheduledEnd <= input.scheduledStart) throw badRequest('VALIDATION_ERROR', 'End must be after start');
      await tx
        .update(visits)
        .set({
          scheduledStart: new Date(input.scheduledStart), scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : null,
          ...(input.repMembershipId ? { repMembershipId: input.repMembershipId } : {}),
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}), updatedAt: new Date(),
        })
        .where(and(eq(visits.tenantId, auth.tenantId), eq(visits.id, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'visit.reschedule', entityType: 'visit', entityId: id, before: { scheduledStart: v.scheduledStart, repMembershipId: v.repMembershipId }, after: input, meta });
      return this.one(tx, auth.tenantId, id);
    });
  }

  /** GPS is optional evidence only — a visit is never "proven" by location alone. */
  checkIn(auth: TenantAuthContext, id: string, geo: { lat?: number; lng?: number; accuracyM?: number }, meta: RequestMeta): Promise<VisitDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const v = await this.load(tx, auth, scope, id, true);
      if (v.repMembershipId !== auth.membershipId) throw forbidden('Only the assigned rep can check in');
      if (v.status !== 'scheduled') throw new AppError(409, 'INVALID_STATE', 'Visit already started or closed');
      await tx
        .update(visits)
        .set({ status: 'in_progress', checkInAt: new Date(), checkInLat: geo.lat ?? null, checkInLng: geo.lng ?? null, checkInAccuracyM: geo.accuracyM ?? null, updatedAt: new Date() })
        .where(and(eq(visits.tenantId, auth.tenantId), eq(visits.id, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'visit.check_in', entityType: 'visit', entityId: id, after: { withLocation: geo.lat !== undefined }, meta });
      return this.one(tx, auth.tenantId, id);
    });
  }

  /**
   * Records the outcome (and checks out). Creates the follow-up task, logs the timeline, and advances a linked
   * opportunity to "visit done" — an event-based move with the visit as evidence.
   */
  complete(auth: TenantAuthContext, id: string, input: VisitOutcomeInput & { lat?: number; lng?: number }, meta: RequestMeta): Promise<VisitDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const v = await this.load(tx, auth, scope, id, true);
      if (v.status === 'completed' || v.status === 'cancelled') throw new AppError(409, 'INVALID_STATE', 'Visit already closed');
      const now = new Date();
      let followUpTaskId: string | null = null;
      if (input.nextFollowUpAt) {
        const f = FOLLOW_UP_TITLE[input.nextStep] ?? FOLLOW_UP_TITLE.none!;
        followUpTaskId = await this.tasksSvc.createFollowUp(tx, auth, {
          accountId: v.accountId, opportunityId: v.opportunityId, visitId: v.id, assignee: v.repMembershipId,
          dueAt: new Date(input.nextFollowUpAt), title: f.title, type: f.type,
        });
      }
      await tx
        .update(visits)
        .set({
          status: 'completed', checkInAt: v.checkInAt ?? now, checkOutAt: now, checkOutLat: input.lat ?? null, checkOutLng: input.lng ?? null,
          outcome: input.outcome, interestLevel: input.interestLevel ?? null, nextStep: input.nextStep,
          nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null, notes: input.notes ?? null, followUpTaskId, updatedAt: now,
        })
        .where(and(eq(visits.tenantId, auth.tenantId), eq(visits.id, id)));
      await this.activity.record(tx, { tenantId: auth.tenantId, accountId: v.accountId, opportunityId: v.opportunityId, type: 'visit_completed', actorUserId: auth.userId, refType: 'visit', refId: id, summary: input.notes ?? input.outcome });
      if (v.opportunityId && input.outcome !== 'not_met') {
        await this.opps.advanceOnEvent(tx, auth, v.opportunityId, 'visit_done', { visitId: id, event: 'visit_completed', outcome: input.outcome });
      }
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'visit.complete', entityType: 'visit', entityId: id, after: { outcome: input.outcome, nextStep: input.nextStep, followUpTaskId }, meta });
      return this.one(tx, auth.tenantId, id);
    });
  }

  cancel(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<VisitDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const v = await this.load(tx, auth, scope, id, true);
      if (v.status !== 'scheduled') throw new AppError(409, 'INVALID_STATE', 'Only scheduled visits can be cancelled');
      await tx.update(visits).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(visits.tenantId, auth.tenantId), eq(visits.id, id)));
      await this.activity.record(tx, { tenantId: auth.tenantId, accountId: v.accountId, opportunityId: v.opportunityId, type: 'visit_cancelled', actorUserId: auth.userId, refType: 'visit', refId: id });
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'visit.cancel', entityType: 'visit', entityId: id, meta });
      return this.one(tx, auth.tenantId, id);
    });
  }
}
