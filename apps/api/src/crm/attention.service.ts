import { Injectable } from '@nestjs/common';
import { accounts, memberships, opportunities, pipelineStages, tasks, users, visits } from '@rakan/db';
import type { AttentionItemDto } from '@rakan/shared';
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { ScopeService } from './scope';

const DAY = 86400_000;
export const STALE_DEAL_DAYS = 14;
export const HOT_LEAD_DAYS = 21;

/**
 * "Needs attention": neglected customers, found by rules (no AI, no cost), explained in plain words.
 * - open deal with no activity on the account for 14+ days
 * - overdue follow-up tasks
 * - a completed visit whose next step was never turned into a task
 * - an A/B-scored lead nobody has visited or touched for 21+ days
 * Reps see their own accounts; managers see the team.
 */
@Injectable()
export class AttentionService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: ScopeService,
  ) {}

  async list(auth: TenantAuthContext, opts: { limit?: number } = {}): Promise<AttentionItemDto[]> {
    const limit = opts.limit ?? 50;
    const now = Date.now();
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const own = scope.restricted ? eq(accounts.ownerMembershipId, auth.membershipId) : undefined;
      const ownerName = sql<string | null>`(SELECT u.full_name FROM ${memberships} m JOIN ${users} u ON u.id = m.user_id WHERE m.id = ${accounts.ownerMembershipId})`;
      const items: AttentionItemDto[] = [];
      const days = (d: Date | null) => (d ? Math.floor((now - d.getTime()) / DAY) : null);

      // 1. Open deals on silent accounts
      const stale = await tx
        .select({ accountId: accounts.id, name: accounts.name, last: accounts.lastActivityAt, owner: ownerName, title: opportunities.title, oppId: opportunities.id, amount: opportunities.amount })
        .from(opportunities)
        .innerJoin(accounts, and(eq(accounts.tenantId, opportunities.tenantId), eq(accounts.id, opportunities.accountId)))
        .innerJoin(pipelineStages, and(eq(pipelineStages.tenantId, opportunities.tenantId), eq(pipelineStages.id, opportunities.stageId)))
        .where(and(
          eq(opportunities.tenantId, auth.tenantId), isNull(opportunities.deletedAt), isNull(accounts.deletedAt), eq(pipelineStages.category, 'open'),
          or(isNull(accounts.lastActivityAt), lt(accounts.lastActivityAt, new Date(now - STALE_DEAL_DAYS * DAY))), own,
        ))
        .limit(limit);
      for (const r of stale) {
        items.push({ type: 'stale_deal', accountId: r.accountId, accountName: r.name, ownerName: r.owner, days: days(r.last), detail: r.title, refId: r.oppId, amount: r.amount, suggestion: 'call_or_visit' });
      }

      // 2. Overdue tasks
      const overdue = await tx
        .select({ taskId: tasks.id, title: tasks.title, due: tasks.dueAt, accountId: accounts.id, name: accounts.name, owner: ownerName })
        .from(tasks)
        .leftJoin(accounts, and(eq(accounts.tenantId, tasks.tenantId), eq(accounts.id, tasks.accountId)))
        .where(and(
          eq(tasks.tenantId, auth.tenantId), eq(tasks.status, 'open'), lt(tasks.dueAt, new Date(now)),
          scope.restricted ? eq(tasks.assigneeMembershipId, auth.membershipId) : undefined,
        ))
        .limit(limit);
      for (const r of overdue) {
        items.push({ type: 'overdue_task', accountId: r.accountId, accountName: r.name, ownerName: r.owner, days: days(r.due), detail: r.title, refId: r.taskId, amount: null, suggestion: 'complete_task' });
      }

      // 3. Visits whose next step never became a task
      const loose = await tx
        .select({ visitId: visits.id, at: visits.checkOutAt, nextStep: visits.nextStep, accountId: accounts.id, name: accounts.name, owner: ownerName })
        .from(visits)
        .innerJoin(accounts, and(eq(accounts.tenantId, visits.tenantId), eq(accounts.id, visits.accountId)))
        .where(and(
          eq(visits.tenantId, auth.tenantId), eq(visits.status, 'completed'), isNull(visits.followUpTaskId), ne(visits.nextStep, 'none'),
          gte(visits.checkOutAt, new Date(now - 30 * DAY)), isNull(accounts.deletedAt),
          scope.restricted ? eq(visits.repMembershipId, auth.membershipId) : undefined,
        ))
        .limit(limit);
      for (const r of loose) {
        items.push({ type: 'visit_without_follow_up', accountId: r.accountId, accountName: r.name, ownerName: r.owner, days: days(r.at), detail: r.nextStep ?? '', refId: r.visitId, amount: null, suggestion: 'create_follow_up' });
      }

      // 4. Good leads (A/B) left untouched
      const hot = await tx
        .select({ accountId: accounts.id, name: accounts.name, tier: accounts.scoreTier, last: accounts.lastActivityAt, owner: ownerName })
        .from(accounts)
        .where(and(
          eq(accounts.tenantId, auth.tenantId), isNull(accounts.deletedAt), inArray(accounts.scoreTier, ['A', 'B']),
          or(isNull(accounts.lastActivityAt), lt(accounts.lastActivityAt, new Date(now - HOT_LEAD_DAYS * DAY))), own,
          sql`NOT EXISTS (SELECT 1 FROM ${visits} v WHERE v.tenant_id = ${accounts.tenantId} AND v.account_id = ${accounts.id} AND v.scheduled_start > now() - interval '${sql.raw(String(HOT_LEAD_DAYS))} days')`,
        ))
        .limit(limit);
      for (const r of hot) {
        items.push({ type: 'hot_lead_untouched', accountId: r.accountId, accountName: r.name, ownerName: r.owner, days: days(r.last), detail: r.tier ?? '', refId: r.accountId, amount: null, suggestion: 'schedule_visit' });
      }

      // Most urgent first: hot leads and stale deals by age, then the rest.
      const weight: Record<AttentionItemDto['type'], number> = { hot_lead_untouched: 4, stale_deal: 3, visit_without_follow_up: 2, overdue_task: 1 };
      return items.sort((a, b) => weight[b.type] - weight[a.type] || (b.days ?? 999) - (a.days ?? 999)).slice(0, limit);
    });
  }
}
