import { Injectable } from '@nestjs/common';
import type { DashboardDto } from '@rakan/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { badRequest } from '../common/errors';
import { CrmSettingsService } from './settings.service';

/**
 * Dashboard metrics. Definitions follow docs/01-PRD.md §9. All queries filter tenant_id explicitly
 * (RLS also applies) and the optional track filter goes through the account.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    private readonly settings: CrmSettingsService,
  ) {}

  dashboard(auth: TenantAuthContext, q: { from: Date; to: Date; trackId?: string }): Promise<DashboardDto> {
    if (q.to <= q.from || q.to.getTime() - q.from.getTime() > 400 * 86400_000) throw badRequest('INVALID_RANGE', 'Invalid period');
    const t = auth.tenantId;
    const { from, to } = q;
    const trackAcc = (alias: string): SQL => (q.trackId ? sql`AND ${sql.raw(alias)}.track_id = ${q.trackId}` : sql``);
    return this.db.tenant(auth, async (tx) => {
      const one = async <T>(query: SQL): Promise<T> => ((await tx.execute(query)).rows[0] as T);
      const many = async <T>(query: SQL): Promise<T[]> => (await tx.execute(query)).rows as T[];
      const now = new Date();

      const accountsTotals = await one<{ total: number; new: number }>(sql`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE a.created_at >= ${from} AND a.created_at < ${to})::int AS new
        FROM accounts a WHERE a.tenant_id = ${t} AND a.deleted_at IS NULL ${trackAcc('a')}`);

      const entered = async (stageKey: string) =>
        (await one<{ n: number }>(sql`
          SELECT count(DISTINCT h.opportunity_id)::int AS n
          FROM opportunity_stage_history h
          JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.id = h.to_stage_id
          JOIN opportunities o ON o.tenant_id = h.tenant_id AND o.id = h.opportunity_id AND o.deleted_at IS NULL
          JOIN accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id AND a.deleted_at IS NULL
          WHERE h.tenant_id = ${t} AND s.key = ${stageKey} AND h.changed_at >= ${from} AND h.changed_at < ${to} ${trackAcc('a')}`)).n;

      const visits = await one<{ scheduled: number; completed: number; cancelled: number; due: number; due_completed: number }>(sql`
        SELECT count(*) FILTER (WHERE v.status <> 'cancelled')::int AS scheduled,
               count(*) FILTER (WHERE v.status = 'completed')::int AS completed,
               count(*) FILTER (WHERE v.status = 'cancelled')::int AS cancelled,
               count(*) FILTER (WHERE v.status <> 'cancelled' AND v.scheduled_start < ${now})::int AS due,
               count(*) FILTER (WHERE v.status = 'completed' AND v.scheduled_start < ${now})::int AS due_completed
        FROM visits v JOIN accounts a ON a.tenant_id = v.tenant_id AND a.id = v.account_id AND a.deleted_at IS NULL
        WHERE v.tenant_id = ${t} AND v.scheduled_start >= ${from} AND v.scheduled_start < ${to} ${trackAcc('a')}`);

      const opps = await one<{ open: number; pipeline_value: string | null; won: number; lost: number; won_value: string | null }>(sql`
        SELECT count(*) FILTER (WHERE s.category = 'open')::int AS open,
               sum(o.amount) FILTER (WHERE s.category = 'open') AS pipeline_value,
               count(*) FILTER (WHERE s.category = 'won' AND o.closed_at >= ${from} AND o.closed_at < ${to})::int AS won,
               count(*) FILTER (WHERE s.category = 'lost' AND o.closed_at >= ${from} AND o.closed_at < ${to})::int AS lost,
               sum(o.amount) FILTER (WHERE s.category = 'won' AND o.closed_at >= ${from} AND o.closed_at < ${to}) AS won_value
        FROM opportunities o
        JOIN pipeline_stages s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
        JOIN accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id AND a.deleted_at IS NULL
        WHERE o.tenant_id = ${t} AND o.deleted_at IS NULL ${trackAcc('a')}`);

      const tasks = await one<{ overdue: number; due: number; on_time: number }>(sql`
        SELECT count(*) FILTER (WHERE tk.status = 'open' AND tk.due_at < ${now})::int AS overdue,
               count(*) FILTER (WHERE tk.status <> 'cancelled' AND tk.due_at >= ${from} AND tk.due_at < LEAST(${to}::timestamptz, ${now}::timestamptz))::int AS due,
               count(*) FILTER (WHERE tk.status = 'done' AND tk.completed_at <= tk.due_at AND tk.due_at >= ${from} AND tk.due_at < LEAST(${to}::timestamptz, ${now}::timestamptz))::int AS on_time
        FROM tasks tk LEFT JOIN accounts a ON a.tenant_id = tk.tenant_id AND a.id = tk.account_id
        WHERE tk.tenant_id = ${t} AND (tk.account_id IS NULL OR a.deleted_at IS NULL)
          ${q.trackId ? sql`AND a.track_id = ${q.trackId}` : sql``}`);

      const byRep = await many<{ membership_id: string; name: string; visits_completed: number; tasks_done: number; won: number; open_value: string | null }>(sql`
        SELECT m.id AS membership_id, u.full_name AS name,
          (SELECT count(*) FROM visits v JOIN accounts a ON a.tenant_id = v.tenant_id AND a.id = v.account_id AND a.deleted_at IS NULL
             WHERE v.tenant_id = ${t} AND v.rep_membership_id = m.id AND v.status = 'completed'
               AND v.check_out_at >= ${from} AND v.check_out_at < ${to} ${trackAcc('a')})::int AS visits_completed,
          (SELECT count(*) FROM tasks tk WHERE tk.tenant_id = ${t} AND tk.assignee_membership_id = m.id AND tk.status = 'done'
               AND tk.completed_at >= ${from} AND tk.completed_at < ${to})::int AS tasks_done,
          (SELECT count(*) FROM opportunities o JOIN pipeline_stages s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
             JOIN accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id AND a.deleted_at IS NULL
             WHERE o.tenant_id = ${t} AND o.owner_membership_id = m.id AND o.deleted_at IS NULL AND s.category = 'won'
               AND o.closed_at >= ${from} AND o.closed_at < ${to} ${trackAcc('a')})::int AS won,
          (SELECT sum(o.amount) FROM opportunities o JOIN pipeline_stages s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
             JOIN accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id AND a.deleted_at IS NULL
             WHERE o.tenant_id = ${t} AND o.owner_membership_id = m.id AND o.deleted_at IS NULL AND s.category = 'open' ${trackAcc('a')}) AS open_value
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ${t} AND m.status = 'active' AND m.role IN ('rep', 'manager', 'owner')
        ORDER BY u.full_name`);

      const lossReasons = await many<{ label: string; count: number }>(sql`
        SELECT coalesce(r.label, '—') AS label, count(*)::int AS count
        FROM opportunities o
        JOIN pipeline_stages s ON s.tenant_id = o.tenant_id AND s.id = o.stage_id
        JOIN accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id AND a.deleted_at IS NULL
        LEFT JOIN outcome_reasons r ON r.tenant_id = o.tenant_id AND r.id = o.outcome_reason_id
        WHERE o.tenant_id = ${t} AND o.deleted_at IS NULL AND s.category = 'lost' AND o.closed_at >= ${from} AND o.closed_at < ${to} ${trackAcc('a')}
        GROUP BY 1 ORDER BY 2 DESC`);

      const pipeline = await this.settings.pipelineFor(tx, t, q.trackId ?? null);
      const funnelRows = await many<{ stage_id: string; count: number; value: string | null }>(sql`
        SELECT o.stage_id, count(*)::int AS count, sum(o.amount) AS value
        FROM opportunities o JOIN accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id AND a.deleted_at IS NULL
        WHERE o.tenant_id = ${t} AND o.deleted_at IS NULL AND o.pipeline_id = ${pipeline.id} ${trackAcc('a')}
        GROUP BY o.stage_id`);

      const won = opps.won;
      const lost = opps.lost;
      const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          accounts: accountsTotals.total,
          newAccounts: accountsTotals.new,
          qualified: await entered('qualified'),
          visitsScheduled: visits.scheduled,
          visitsCompleted: visits.completed,
          visitsCancelled: visits.cancelled,
          proposalsSent: await entered('proposal_sent'),
          openOpportunities: opps.open,
          won,
          lost,
          pipelineValue: Number(opps.pipeline_value ?? 0),
          wonValue: Number(opps.won_value ?? 0),
          winRate: ratio(won, won + lost),
          overdueTasks: tasks.overdue,
          visitCompletionRate: ratio(visits.due_completed, visits.due),
          followUpCompletionRate: ratio(tasks.on_time, tasks.due),
        },
        byRep: byRep.map((r) => ({
          membershipId: r.membership_id, name: r.name, visitsCompleted: r.visits_completed, tasksDone: r.tasks_done, won: r.won, openValue: Number(r.open_value ?? 0),
        })),
        lossReasons,
        stageFunnel: pipeline.stages.map((s) => {
          const f = funnelRows.find((r) => r.stage_id === s.id);
          return { stageId: s.id, name: s.name, count: f?.count ?? 0, value: Number(f?.value ?? 0) };
        }),
      };
    });
  }
}
