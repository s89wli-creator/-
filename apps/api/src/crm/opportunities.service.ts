import { Injectable } from '@nestjs/common';
import {
  accounts, memberships, opportunities, opportunityStageHistory, outcomeReasons, pipelineStages, users, type Tx,
} from '@rakan/db';
import type { OpportunityDto, OpportunityInput, StageHistoryDto } from '@rakan/shared';
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, forbidden, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from './accounts.service';
import { ActivityService } from './activity.service';
import { loadDefs, validateCustomValues } from './custom-fields';
import { ScopeService, type RecordScope } from './scope';
import { CrmSettingsService } from './settings.service';

type OppRow = typeof opportunities.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;

const REASON_KIND: Record<string, 'win' | 'loss' | 'postpone' | undefined> = { won: 'win', lost: 'loss', postponed: 'postpone' };

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly activity: ActivityService,
    private readonly accountsSvc: AccountsService,
    private readonly settings: CrmSettingsService,
  ) {}

  private async dto(tx: Tx, tenantId: string, o: OppRow): Promise<OpportunityDto> {
    const [extra] = await tx
      .select({ accountName: accounts.name, category: pipelineStages.category, ownerName: users.fullName })
      .from(opportunities)
      .innerJoin(accounts, and(eq(accounts.tenantId, opportunities.tenantId), eq(accounts.id, opportunities.accountId)))
      .innerJoin(pipelineStages, and(eq(pipelineStages.tenantId, opportunities.tenantId), eq(pipelineStages.id, opportunities.stageId)))
      .leftJoin(memberships, and(eq(memberships.tenantId, opportunities.tenantId), eq(memberships.id, opportunities.ownerMembershipId)))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.id, o.id)));
    return {
      id: o.id, accountId: o.accountId, accountName: extra!.accountName, title: o.title, pipelineId: o.pipelineId, stageId: o.stageId,
      stageCategory: extra!.category, ownerMembershipId: o.ownerMembershipId, ownerName: extra!.ownerName ?? null, amount: o.amount,
      currency: o.currency, expectedCloseDate: o.expectedCloseDate, outcomeReasonId: o.outcomeReasonId, outcomeNote: o.outcomeNote,
      closedAt: o.closedAt?.toISOString() ?? null, customFields: o.customFields, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
    };
  }

  /** Visible if the rep owns the opportunity or its account. */
  private scopeWhere(scope: RecordScope): SQL | undefined {
    if (!scope.restricted || scope.readAll) return undefined;
    return or(eq(opportunities.ownerMembershipId, scope.membershipId), eq(accounts.ownerMembershipId, scope.membershipId));
  }

  async loadOpp(tx: Tx, auth: TenantAuthContext, scope: RecordScope, id: string, write = false): Promise<OppRow> {
    const [row] = await tx
      .select({ o: opportunities, accountOwner: accounts.ownerMembershipId })
      .from(opportunities)
      .innerJoin(accounts, and(eq(accounts.tenantId, opportunities.tenantId), eq(accounts.id, opportunities.accountId)))
      .where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, id), isNull(opportunities.deletedAt), isNull(accounts.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Opportunity');
    if (scope.restricted) {
      const mine = row.o.ownerMembershipId === scope.membershipId || row.accountOwner === scope.membershipId;
      if (!mine && (write || !scope.readAll)) throw write && scope.readAll ? forbidden('You can only modify your own opportunities') : notFound('Opportunity');
    }
    return row.o;
  }

  list(auth: TenantAuthContext, q: { pipelineId?: string; accountId?: string; ownerMembershipId?: string; status?: 'open' | 'closed' | 'all' }): Promise<OpportunityDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const where: (SQL | undefined)[] = [eq(opportunities.tenantId, auth.tenantId), isNull(opportunities.deletedAt), isNull(accounts.deletedAt), this.scopeWhere(scope)];
      if (q.pipelineId) where.push(eq(opportunities.pipelineId, q.pipelineId));
      if (q.accountId) where.push(eq(opportunities.accountId, q.accountId));
      if (q.ownerMembershipId) where.push(eq(opportunities.ownerMembershipId, q.ownerMembershipId));
      if (q.status === 'open') where.push(eq(pipelineStages.category, 'open'));
      if (q.status === 'closed') where.push(inArray(pipelineStages.category, ['won', 'lost', 'postponed']));
      const rows = await tx
        .select({ o: opportunities, accountName: accounts.name, category: pipelineStages.category, ownerName: users.fullName })
        .from(opportunities)
        .innerJoin(accounts, and(eq(accounts.tenantId, opportunities.tenantId), eq(accounts.id, opportunities.accountId)))
        .innerJoin(pipelineStages, and(eq(pipelineStages.tenantId, opportunities.tenantId), eq(pipelineStages.id, opportunities.stageId)))
        .leftJoin(memberships, and(eq(memberships.tenantId, opportunities.tenantId), eq(memberships.id, opportunities.ownerMembershipId)))
        .leftJoin(users, eq(users.id, memberships.userId))
        .where(and(...where))
        .orderBy(desc(opportunities.updatedAt))
        .limit(1000);
      return rows.map(({ o, accountName, category, ownerName }) => ({
        id: o.id, accountId: o.accountId, accountName, title: o.title, pipelineId: o.pipelineId, stageId: o.stageId, stageCategory: category,
        ownerMembershipId: o.ownerMembershipId, ownerName: ownerName ?? null, amount: o.amount, currency: o.currency,
        expectedCloseDate: o.expectedCloseDate, outcomeReasonId: o.outcomeReasonId, outcomeNote: o.outcomeNote,
        closedAt: o.closedAt?.toISOString() ?? null, customFields: o.customFields, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
      }));
    });
  }

  get(auth: TenantAuthContext, id: string): Promise<OpportunityDto & { history: StageHistoryDto[] }> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const o = await this.loadOpp(tx, auth, scope, id);
      const history = await tx
        .select({ h: opportunityStageHistory, name: users.fullName })
        .from(opportunityStageHistory)
        .leftJoin(users, eq(users.id, opportunityStageHistory.changedByUserId))
        .where(and(eq(opportunityStageHistory.tenantId, auth.tenantId), eq(opportunityStageHistory.opportunityId, id)))
        .orderBy(asc(opportunityStageHistory.id));
      return {
        ...(await this.dto(tx, auth.tenantId, o)),
        history: history.map(({ h, name }) => ({
          id: h.id, fromStageId: h.fromStageId, toStageId: h.toStageId, changedByType: h.changedByType, changedByName: name ?? null,
          evidence: h.evidence, changedAt: h.changedAt.toISOString(),
        })),
      };
    });
  }

  private async stage(tx: Tx, tenantId: string, stageId: string): Promise<StageRow> {
    const [s] = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.tenantId, tenantId), eq(pipelineStages.id, stageId)));
    if (!s) throw badRequest('INVALID_REFERENCE', 'Unknown stage', [{ path: 'stageId', message: 'Unknown stage', code: 'invalid_reference' }]);
    return s;
  }

  create(auth: TenantAuthContext, input: OpportunityInput, meta: RequestMeta): Promise<OpportunityDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const account = await this.accountsSvc.loadAccount(tx, auth, scope, input.accountId, true);
      const pipeline = input.pipelineId
        ? (await this.settings.load(tx, auth.tenantId)).pipelines.find((p) => p.id === input.pipelineId)
        : await this.settings.pipelineFor(tx, auth.tenantId, account.trackId);
      if (!pipeline) throw badRequest('INVALID_REFERENCE', 'Unknown pipeline');
      const stage = input.stageId ? pipeline.stages.find((s) => s.id === input.stageId) : pipeline.stages.find((s) => s.category === 'open');
      if (!stage) throw badRequest('INVALID_REFERENCE', 'Unknown stage', [{ path: 'stageId', message: 'Stage not in pipeline', code: 'invalid_reference' }]);
      if (stage.category !== 'open') throw badRequest('INVALID_STAGE', 'New opportunities must start in an open stage');
      let owner = input.ownerMembershipId ?? account.ownerMembershipId ?? auth.membershipId;
      if (scope.restricted) owner = auth.membershipId;
      const defs = await loadDefs(tx, auth.tenantId, 'opportunity');
      const customFields = validateCustomValues(defs, input.customFields);
      const [o] = await tx
        .insert(opportunities)
        .values({
          tenantId: auth.tenantId, accountId: account.id, pipelineId: pipeline.id, stageId: stage.id, title: input.title,
          ownerMembershipId: owner, amount: input.amount ?? null, expectedCloseDate: input.expectedCloseDate ?? null, customFields, createdBy: auth.userId,
        })
        .returning();
      await tx.insert(opportunityStageHistory).values({
        tenantId: auth.tenantId, opportunityId: o!.id, fromStageId: null, toStageId: stage.id, changedByType: 'user', changedByUserId: auth.userId,
      });
      await this.activity.record(tx, {
        tenantId: auth.tenantId, accountId: account.id, opportunityId: o!.id, type: 'opportunity_created', actorUserId: auth.userId, summary: o!.title,
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'opportunity.create', entityType: 'opportunity', entityId: o!.id,
        after: { title: o!.title, amount: o!.amount, stage: stage.key }, meta,
      });
      return this.dto(tx, auth.tenantId, o!);
    });
  }

  update(auth: TenantAuthContext, id: string, input: Partial<OpportunityInput>, meta: RequestMeta): Promise<OpportunityDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const before = await this.loadOpp(tx, auth, scope, id, true);
      if (scope.restricted && input.ownerMembershipId !== undefined && input.ownerMembershipId !== before.ownerMembershipId) throw forbidden('Reps cannot reassign opportunities');
      if (input.ownerMembershipId) {
        const [m] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, input.ownerMembershipId)));
        if (!m) throw badRequest('INVALID_REFERENCE', 'Unknown owner');
      }
      const defs = input.customFields ? await loadDefs(tx, auth.tenantId, 'opportunity') : [];
      const [o] = await tx
        .update(opportunities)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.expectedCloseDate !== undefined ? { expectedCloseDate: input.expectedCloseDate } : {}),
          ...(input.ownerMembershipId !== undefined ? { ownerMembershipId: input.ownerMembershipId } : {}),
          ...(input.customFields ? { customFields: validateCustomValues(defs, input.customFields, before.customFields) } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, id)))
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'opportunity.update', entityType: 'opportunity', entityId: id,
        before: { title: before.title, amount: before.amount, expectedCloseDate: before.expectedCloseDate, ownerMembershipId: before.ownerMembershipId },
        after: { title: o!.title, amount: o!.amount, expectedCloseDate: o!.expectedCloseDate, ownerMembershipId: o!.ownerMembershipId }, meta,
      });
      return this.dto(tx, auth.tenantId, o!);
    });
  }

  /**
   * Single entry point for stage changes (user moves and confirmed system events).
   * Closing as won/lost/postponed requires a reason of the matching kind.
   */
  async applyStage(
    tx: Tx,
    auth: TenantAuthContext,
    o: OppRow,
    target: StageRow,
    opts: { by: 'user' | 'system_event'; outcomeReasonId?: string | null; note?: string | null; evidence?: Record<string, unknown> },
    meta?: RequestMeta,
  ): Promise<OppRow> {
    if (target.pipelineId !== o.pipelineId) throw badRequest('INVALID_STAGE', 'Stage belongs to another pipeline');
    if (target.id === o.stageId) return o;
    const kind = REASON_KIND[target.category];
    let reasonId: string | null = null;
    if (kind) {
      if (!opts.outcomeReasonId) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required for this stage', { kind });
      const [r] = await tx
        .select()
        .from(outcomeReasons)
        .where(and(eq(outcomeReasons.tenantId, auth.tenantId), eq(outcomeReasons.id, opts.outcomeReasonId), eq(outcomeReasons.kind, kind), eq(outcomeReasons.isActive, true)));
      if (!r) throw badRequest('INVALID_REFERENCE', 'Reason does not match this stage', [{ path: 'outcomeReasonId', message: 'Invalid reason', code: 'invalid_reference' }]);
      reasonId = r.id;
    }
    const closing = target.category !== 'open';
    const [updated] = await tx
      .update(opportunities)
      .set({
        stageId: target.id,
        outcomeReasonId: reasonId,
        outcomeNote: closing ? opts.note ?? null : null,
        closedAt: closing ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, o.id)))
      .returning();
    await tx.insert(opportunityStageHistory).values({
      tenantId: auth.tenantId, opportunityId: o.id, fromStageId: o.stageId, toStageId: target.id, changedByType: opts.by,
      changedByUserId: auth.userId, evidence: { ...(opts.evidence ?? {}), ...(reasonId ? { outcomeReasonId: reasonId } : {}), ...(opts.note ? { note: opts.note } : {}) },
    });
    await this.activity.record(tx, {
      tenantId: auth.tenantId, accountId: o.accountId, opportunityId: o.id, type: 'stage_changed',
      actorType: opts.by === 'user' ? 'user' : 'system', actorUserId: auth.userId, refType: 'stage', refId: target.id, summary: target.name,
    });
    if (target.category === 'won') {
      await tx.update(accounts).set({ status: 'customer' }).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, o.accountId), eq(accounts.status, 'active')));
    }
    if (meta || opts.by === 'system_event') {
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorType: opts.by === 'user' ? 'user' : 'system', actorUserId: auth.userId, action: 'opportunity.stage',
        entityType: 'opportunity', entityId: o.id, before: { stageId: o.stageId }, after: { stageId: target.id, outcomeReasonId: reasonId, by: opts.by }, meta,
      });
    }
    return updated!;
  }

  /**
   * Event-driven move (e.g. visit scheduled/completed): only moves FORWARD through open stages and never
   * closes or reopens a deal. No guessing: the event itself is the evidence.
   */
  async advanceOnEvent(tx: Tx, auth: TenantAuthContext, opportunityId: string, stageKey: string, evidence: Record<string, unknown>): Promise<void> {
    const [o] = await tx.select().from(opportunities).where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, opportunityId), isNull(opportunities.deletedAt)));
    if (!o) return;
    const stages = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.tenantId, auth.tenantId), eq(pipelineStages.pipelineId, o.pipelineId)));
    const current = stages.find((s) => s.id === o.stageId);
    const target = stages.find((s) => s.key === stageKey);
    if (!current || !target || current.category !== 'open' || target.category !== 'open' || target.position <= current.position) return;
    await this.applyStage(tx, auth, o, target, { by: 'system_event', evidence });
  }

  moveStage(auth: TenantAuthContext, id: string, input: { stageId: string; outcomeReasonId?: string | null; note?: string | null }, meta: RequestMeta): Promise<OpportunityDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const o = await this.loadOpp(tx, auth, scope, id, true);
      const target = await this.stage(tx, auth.tenantId, input.stageId);
      const updated = await this.applyStage(tx, auth, o, target, { by: 'user', outcomeReasonId: input.outcomeReasonId, note: input.note }, meta);
      return this.dto(tx, auth.tenantId, updated);
    });
  }

  remove(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const o = await this.loadOpp(tx, auth, scope, id, true);
      await tx.update(opportunities).set({ deletedAt: new Date() }).where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'opportunity.delete', entityType: 'opportunity', entityId: id, before: { title: o.title, amount: o.amount }, meta });
    });
  }
}
