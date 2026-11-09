import { Injectable } from '@nestjs/common';
import { accounts, memberships, tasks, users, type Tx } from '@rakan/db';
import type { TaskDto, TaskInput } from '@rakan/shared';
import { and, desc, eq, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { badRequest, forbidden, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from './accounts.service';
import { ActivityService } from './activity.service';
import { OpportunitiesService } from './opportunities.service';
import { ScopeService, type RecordScope } from './scope';

type TaskRow = typeof tasks.$inferSelect;

/** Day boundaries in Riyadh time (UTC+3, no DST). */
function riyadhDay(now = new Date()): { start: Date; end: Date } {
  const offset = 3 * 3600_000;
  const local = new Date(now.getTime() + offset);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset);
  return { start, end: new Date(start.getTime() + 86400_000) };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly activity: ActivityService,
    private readonly accountsSvc: AccountsService,
    private readonly opps: OpportunitiesService,
  ) {}

  private async dtos(tx: Tx, tenantId: string, where: SQL, order: SQL[], limit: number): Promise<TaskDto[]> {
    const rows = await tx
      .select({ t: tasks, assigneeName: users.fullName, accountName: accounts.name })
      .from(tasks)
      .leftJoin(memberships, and(eq(memberships.tenantId, tasks.tenantId), eq(memberships.id, tasks.assigneeMembershipId)))
      .leftJoin(users, eq(users.id, memberships.userId))
      .leftJoin(accounts, and(eq(accounts.tenantId, tasks.tenantId), eq(accounts.id, tasks.accountId)))
      .where(and(eq(tasks.tenantId, tenantId), where, or(isNull(tasks.accountId), isNull(accounts.deletedAt))))
      .orderBy(...order)
      .limit(limit);
    return rows.map(({ t, assigneeName, accountName }) => ({
      id: t.id, title: t.title, description: t.description, type: t.type, priority: t.priority, dueAt: t.dueAt?.toISOString() ?? null,
      assigneeMembershipId: t.assigneeMembershipId, assigneeName: assigneeName ?? null, accountId: t.accountId, accountName: accountName ?? null,
      opportunityId: t.opportunityId, visitId: t.visitId, status: t.status, completedAt: t.completedAt?.toISOString() ?? null,
      createdByType: t.createdByType, createdAt: t.createdAt.toISOString(),
    }));
  }

  list(auth: TenantAuthContext, q: { view: string; accountId?: string; assigneeMembershipId?: string; limit: number }): Promise<TaskDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const where: SQL[] = [];
      if (scope.restricted || q.view === 'mine') where.push(eq(tasks.assigneeMembershipId, auth.membershipId));
      else if (q.assigneeMembershipId) where.push(eq(tasks.assigneeMembershipId, q.assigneeMembershipId));
      if (q.accountId) {
        await this.accountsSvc.loadAccount(tx, auth, scope, q.accountId);
        where.push(eq(tasks.accountId, q.accountId));
      }
      const now = new Date();
      const { start, end } = riyadhDay(now);
      let order: SQL[] = [sql`${tasks.dueAt} ASC NULLS LAST`, desc(tasks.createdAt)];
      switch (q.view) {
        case 'overdue': where.push(eq(tasks.status, 'open'), lt(tasks.dueAt, now)); break;
        case 'today': where.push(eq(tasks.status, 'open'), gte(tasks.dueAt, start), lt(tasks.dueAt, end)); break;
        case 'upcoming': where.push(eq(tasks.status, 'open'), or(gte(tasks.dueAt, end), isNull(tasks.dueAt))!); break;
        case 'done': where.push(eq(tasks.status, 'done')); order = [desc(tasks.completedAt)]; break;
        default: where.push(eq(tasks.status, 'open'));
      }
      return this.dtos(tx, auth.tenantId, and(...where)!, order, q.limit);
    });
  }

  private async load(tx: Tx, auth: TenantAuthContext, scope: RecordScope, id: string): Promise<TaskRow> {
    const [t] = await tx.select().from(tasks).where(and(eq(tasks.tenantId, auth.tenantId), eq(tasks.id, id)));
    if (!t) throw notFound('Task');
    if (scope.restricted && t.assigneeMembershipId !== scope.membershipId) throw notFound('Task');
    return t;
  }

  private async validateLinks(tx: Tx, auth: TenantAuthContext, scope: RecordScope, input: Partial<TaskInput>) {
    if (input.assigneeMembershipId) {
      if (scope.restricted && input.assigneeMembershipId !== auth.membershipId) throw forbidden('Reps can only assign tasks to themselves');
      const [m] = await tx.select({ id: memberships.id }).from(memberships)
        .where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, input.assigneeMembershipId), eq(memberships.status, 'active')));
      if (!m) throw badRequest('INVALID_REFERENCE', 'Unknown assignee', [{ path: 'assigneeMembershipId', message: 'Unknown member', code: 'invalid_reference' }]);
    }
    if (input.accountId) await this.accountsSvc.loadAccount(tx, auth, scope, input.accountId);
    if (input.opportunityId) {
      const o = await this.opps.loadOpp(tx, auth, scope, input.opportunityId);
      if (input.accountId && o.accountId !== input.accountId) throw badRequest('INVALID_REFERENCE', 'Opportunity belongs to another account');
      input.accountId = o.accountId;
    }
  }

  create(auth: TenantAuthContext, input: TaskInput, meta: RequestMeta): Promise<TaskDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const data = { ...input, assigneeMembershipId: input.assigneeMembershipId ?? auth.membershipId };
      await this.validateLinks(tx, auth, scope, data);
      const [t] = await tx
        .insert(tasks)
        .values({
          tenantId: auth.tenantId, title: data.title, description: data.description ?? null, type: data.type, priority: data.priority,
          dueAt: data.dueAt ? new Date(data.dueAt) : null, assigneeMembershipId: data.assigneeMembershipId, accountId: data.accountId ?? null,
          opportunityId: data.opportunityId ?? null, createdByType: 'user', createdByUserId: auth.userId,
        })
        .returning();
      if (t!.accountId) {
        await this.activity.record(tx, { tenantId: auth.tenantId, accountId: t!.accountId, opportunityId: t!.opportunityId, type: 'task_created', actorUserId: auth.userId, refType: 'task', refId: t!.id, summary: t!.title });
      }
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'task.create', entityType: 'task', entityId: t!.id, after: { title: t!.title, dueAt: t!.dueAt, assigneeMembershipId: t!.assigneeMembershipId }, meta });
      return (await this.dtos(tx, auth.tenantId, eq(tasks.id, t!.id), [], 1))[0]!;
    });
  }

  /** Used by visit outcomes: creates a follow-up task inside the caller's transaction. */
  async createFollowUp(tx: Tx, auth: TenantAuthContext, v: { accountId: string; opportunityId: string | null; visitId: string; assignee: string; dueAt: Date; title: string; type: string }): Promise<string> {
    const [t] = await tx
      .insert(tasks)
      .values({
        tenantId: auth.tenantId, title: v.title, type: v.type, dueAt: v.dueAt, assigneeMembershipId: v.assignee, accountId: v.accountId,
        opportunityId: v.opportunityId, visitId: v.visitId, createdByType: 'system', createdByUserId: auth.userId,
      })
      .returning({ id: tasks.id });
    await this.activity.record(tx, { tenantId: auth.tenantId, accountId: v.accountId, opportunityId: v.opportunityId, type: 'task_created', actorType: 'system', actorUserId: auth.userId, refType: 'task', refId: t!.id, summary: v.title });
    return t!.id;
  }

  update(auth: TenantAuthContext, id: string, input: Partial<TaskInput> & { status?: 'open' | 'done' | 'cancelled' }, meta: RequestMeta): Promise<TaskDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const before = await this.load(tx, auth, scope, id);
      await this.validateLinks(tx, auth, scope, input);
      const completing = input.status === 'done' && before.status !== 'done';
      const [t] = await tx
        .update(tasks)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
          ...(input.assigneeMembershipId !== undefined ? { assigneeMembershipId: input.assigneeMembershipId } : {}),
          ...(input.status !== undefined ? { status: input.status, completedAt: input.status === 'done' ? before.completedAt ?? new Date() : null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.tenantId, auth.tenantId), eq(tasks.id, id)))
        .returning();
      if (completing && t!.accountId) {
        await this.activity.record(tx, { tenantId: auth.tenantId, accountId: t!.accountId, opportunityId: t!.opportunityId, type: 'task_completed', actorUserId: auth.userId, refType: 'task', refId: id, summary: t!.title });
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: completing ? 'task.complete' : 'task.update', entityType: 'task', entityId: id,
        before: { status: before.status, dueAt: before.dueAt, assigneeMembershipId: before.assigneeMembershipId },
        after: { status: t!.status, dueAt: t!.dueAt, assigneeMembershipId: t!.assigneeMembershipId }, meta,
      });
      return (await this.dtos(tx, auth.tenantId, eq(tasks.id, id), [], 1))[0]!;
    });
  }

  /** Overdue open tasks (used by the dashboard). */
  static overdueWhere(now = new Date()): SQL {
    return and(eq(tasks.status, 'open'), lt(tasks.dueAt, now))!;
  }
}

