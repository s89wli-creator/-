import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { accounts, approvalRequests, jobRuns, memberships, scheduledJobs, tasks, users, visitBriefs, visits, type JobKey, type Tx } from '@rakan/db';
import { AI_JOBS, JOBS, hasPermission, permissionsForRole, type JobDto, type JobRunDto, type SystemRole } from '@rakan/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { AgentsService } from '../ai/agents.service';
import { AiRuntimeService } from '../ai/runtime.service';
import { AttentionService } from '../crm/attention.service';
import { MailService } from '../identity/mail.service';
import { CoachService } from './coach.service';
import { NotificationsService } from './notifications.service';

const OFF = 3 * 3600_000; // Riyadh, UTC+3 all year
const DAY = 86400_000;
const TICK_MS = 60_000;
const MAX_BRIEFS_PER_RUN = 30;

export const JOB_DEFAULTS: Record<JobKey, { hour: number; minute: number; days: number[] }> = {
  morning_brief: { hour: 7, minute: 0, days: [0, 1, 2, 3, 4] },
  visit_briefs: { hour: 6, minute: 30, days: [0, 1, 2, 3, 4] },
  weekly_coach: { hour: 8, minute: 0, days: [0] },
};

/** Next time (after `after`) that falls on one of `days` at hour:minute Riyadh time. */
export function nextRunAt(hour: number, minute: number, days: number[], after: Date): Date | null {
  const local = new Date(after.getTime() + OFF);
  for (let d = 0; d <= 7; d++) {
    const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, hour, minute) - OFF;
    if (at > after.getTime() && days.includes(new Date(at + OFF).getUTCDay())) return new Date(at);
  }
  return null;
}

function todayRange(now = new Date()): { start: Date; end: Date } {
  const l = new Date(now.getTime() + OFF);
  const start = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - OFF;
  return { start: new Date(start), end: new Date(start + DAY) };
}
const hhmm = (d: Date) => new Date(d.getTime() + OFF).toISOString().slice(11, 16);

interface Member { membershipId: string; userId: string; role: SystemRole; email: string; fullName: string }
type JobRow = typeof scheduledJobs.$inferSelect;
type Outcome = { status: 'succeeded' | 'failed' | 'skipped'; detail: Record<string, unknown> };

/**
 * Scheduled agents, per company:
 * - morning_brief (no AI): each person's visits today, due/overdue tasks, neglected customers, pending approvals.
 * - visit_briefs (AI): prepares the brief of today's visits that do not have one yet.
 * - weekly_coach (AI): a Sales Coach report for each rep, shared with the rep and the managers.
 * Everything is delivered in the app (and by email if the company turned that on). Nothing goes to customers.
 * Each job runs as the person it is for, with that person's permissions and record scope, inside the
 * company's AI budget. Due jobs are claimed with a lease (claim_due_jobs), so several servers never double-run.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Scheduler');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly runtime: AiRuntimeService,
    private readonly agents: AgentsService,
    private readonly attention: AttentionService,
    private readonly coach: CoachService,
    private readonly notes: NotificationsService,
    private readonly mail: MailService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = this.config.SCHEDULER_ENABLED ?? this.config.NODE_ENV !== 'test';
    if (!enabled) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.log.log('scheduler started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Claims and runs due jobs. Public for tests. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      const r = await this.db.platform((tx) => tx.execute(sql`SELECT * FROM claim_due_jobs(10)`));
      for (const { tenant_id: tenantId, job_id: jobId } of r.rows as { tenant_id: string; job_id: string }[]) {
        const job = await this.db.run({ tenantId }, async (tx) => (await tx.select().from(scheduledJobs).where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.id, jobId))))[0]);
        if (!job) continue;
        await this.runAndRecord(tenantId, job, 'schedule', null);
        n++;
      }
    } catch (e) {
      this.log.error({ err: e }, 'scheduler tick failed');
    } finally {
      this.busy = false;
    }
    return n;
  }

  // ---------------------------------------------------------------- settings

  private dto(job: JobKey, row: JobRow | undefined): JobDto {
    const d = JOB_DEFAULTS[job];
    return {
      job, enabled: row?.enabled ?? false, hour: row?.hour ?? d.hour, minute: row?.minute ?? d.minute, days: row?.days ?? d.days, email: row?.email ?? false,
      usesAi: AI_JOBS.includes(job), nextRunAt: row?.enabled ? (row.nextRunAt?.toISOString() ?? null) : null, lastRunAt: row?.lastRunAt?.toISOString() ?? null,
      lastStatus: row?.lastStatus ?? null, lastDetail: row?.lastDetail ?? null,
    };
  }

  async list(auth: TenantAuthContext): Promise<JobDto[]> {
    const rows = await this.db.tenant(auth, (tx) => tx.select().from(scheduledJobs).where(eq(scheduledJobs.tenantId, auth.tenantId)));
    return JOBS.map((j) => this.dto(j, rows.find((r) => r.job === j)));
  }

  async update(auth: TenantAuthContext, job: JobKey, input: { enabled?: boolean; hour?: number; minute?: number; days?: number[]; email?: boolean }, meta: RequestMeta): Promise<JobDto> {
    return this.db.tenant(auth, async (tx) => {
      const [cur] = await tx.select().from(scheduledJobs).where(and(eq(scheduledJobs.tenantId, auth.tenantId), eq(scheduledJobs.job, job)));
      const before = this.dto(job, cur);
      const next = {
        enabled: input.enabled ?? before.enabled, hour: input.hour ?? before.hour, minute: input.minute ?? before.minute,
        days: [...new Set(input.days ?? before.days)].sort(), email: input.email ?? before.email,
      };
      const nextRun = next.enabled ? nextRunAt(next.hour, next.minute, next.days, new Date()) : null;
      const [row] = await tx
        .insert(scheduledJobs)
        .values({ tenantId: auth.tenantId, job, ...next, nextRunAt: nextRun, updatedBy: auth.userId })
        .onConflictDoUpdate({ target: [scheduledJobs.tenantId, scheduledJobs.job], set: { ...next, nextRunAt: nextRun, updatedBy: auth.userId, updatedAt: new Date() } })
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'automation.update', entityType: 'scheduled_job', entityId: row!.id,
        before: { enabled: before.enabled, hour: before.hour, minute: before.minute, days: before.days, email: before.email }, after: { job, ...next }, meta,
      });
      return this.dto(job, row);
    });
  }

  async runs(auth: TenantAuthContext): Promise<JobRunDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select({ r: jobRuns, name: users.fullName })
        .from(jobRuns)
        .leftJoin(users, eq(users.id, jobRuns.triggeredBy))
        .where(eq(jobRuns.tenantId, auth.tenantId))
        .orderBy(desc(jobRuns.id))
        .limit(50);
      return rows.map(({ r, name }) => ({
        id: r.id, job: r.job, trigger: r.trigger, triggeredByName: name, status: r.status, detail: r.detail, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt.toISOString(),
      }));
    });
  }

  /** "Run now" from the settings page (same work as the schedule; respects the same rules and budget). */
  async runNow(auth: TenantAuthContext, job: JobKey, meta: RequestMeta): Promise<JobRunDto> {
    const [row] = await this.db.tenant(auth, (tx) => tx.select().from(scheduledJobs).where(and(eq(scheduledJobs.tenantId, auth.tenantId), eq(scheduledJobs.job, job))));
    const cfg = row ?? ({ ...JOB_DEFAULTS[job], job, email: false, enabled: false } as unknown as JobRow);
    await this.runAndRecord(auth.tenantId, cfg, 'manual', auth.userId);
    await this.db.tenant(auth, (tx) =>
      this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'automation.run', entityType: 'scheduled_job', entityId: row?.id ?? null, after: { job }, meta }),
    );
    return (await this.runs(auth))[0]!;
  }

  // ---------------------------------------------------------------- running

  private async runAndRecord(tenantId: string, job: JobRow, trigger: 'schedule' | 'manual', by: string | null): Promise<void> {
    const started = new Date();
    let out: Outcome;
    try {
      out = await this.execute(tenantId, job);
    } catch (e) {
      this.log.error({ err: e, tenantId, job: job.job }, 'scheduled job failed');
      out = { status: 'failed', detail: { error: e instanceof AppError ? e.code : 'JOB_FAILED' } };
    }
    await this.db.run({ tenantId }, async (tx) => {
      await tx.insert(jobRuns).values({ tenantId, job: job.job, trigger, triggeredBy: by, status: out.status, detail: out.detail, startedAt: started });
      if (job.id) {
        const fresh = (await tx.select().from(scheduledJobs).where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.id, job.id))))[0];
        await tx
          .update(scheduledJobs)
          .set({
            lastRunAt: started, lastStatus: out.status, lastDetail: out.detail,
            ...(trigger === 'schedule' || fresh?.enabled ? { nextRunAt: fresh?.enabled ? nextRunAt(fresh.hour, fresh.minute, fresh.days, new Date()) : null } : {}),
          })
          .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.id, job.id)));
      }
    });
  }

  private async members(tenantId: string, roles?: SystemRole[]): Promise<Member[]> {
    return this.db.run({ tenantId }, async (tx) => {
      const rows = await tx
        .select({ membershipId: memberships.id, userId: users.id, role: memberships.role, email: users.email, fullName: users.fullName })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active'), roles ? inArray(memberships.role, roles) : undefined))
        .orderBy(asc(users.fullName));
      return rows as Member[];
    });
  }

  /** The person a job works for, with their own permissions (record scope applies as in the app). */
  private authFor(tenantId: string, m: Member): TenantAuthContext {
    return {
      userId: m.userId, sessionId: 'scheduler', email: m.email, fullName: m.fullName, tenantId, membershipId: m.membershipId, role: m.role,
      permissions: permissionsForRole(m.role), tenantStatus: 'active',
    };
  }

  private async deliver(tenantId: string, m: Member, email: boolean, n: { kind: string; title: string; body: string; links: { label: string; href: string }[] }): Promise<boolean> {
    await this.notes.notify({ tenantId, userId: m.userId, ...n });
    if (!email) return false;
    const links = n.links.map((l) => `${l.label}: ${this.config.WEB_ORIGIN}${l.href}`).join('\n');
    await this.mail.send({ to: m.email, subject: `راكان — ${n.title}`, text: `${n.body}\n\n${links}` });
    return true;
  }

  private async execute(tenantId: string, job: JobRow): Promise<Outcome> {
    switch (job.job) {
      case 'morning_brief': return this.morningBrief(tenantId, job);
      case 'visit_briefs': return this.visitBriefs(tenantId, job);
      case 'weekly_coach': return this.weeklyCoach(tenantId, job);
    }
  }

  private async morningBrief(tenantId: string, job: JobRow): Promise<Outcome> {
    const { start, end } = todayRange();
    let notified = 0;
    let emailed = 0;
    for (const m of await this.members(tenantId, ['owner', 'manager', 'rep'])) {
      const auth = this.authFor(tenantId, m);
      const data = await this.db.run({ tenantId, userId: m.userId }, async (tx: Tx) => {
        const own = m.role === 'rep';
        const todays = await tx
          .select({ at: visits.scheduledStart, name: accounts.name })
          .from(visits)
          .innerJoin(accounts, and(eq(accounts.tenantId, visits.tenantId), eq(accounts.id, visits.accountId)))
          .where(and(eq(visits.tenantId, tenantId), eq(visits.repMembershipId, m.membershipId), inArray(visits.status, ['scheduled', 'in_progress']), gte(visits.scheduledStart, start), lt(visits.scheduledStart, end)))
          .orderBy(asc(visits.scheduledStart));
        const [team] = own ? [undefined] : await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(visits)
          .where(and(eq(visits.tenantId, tenantId), inArray(visits.status, ['scheduled', 'in_progress']), gte(visits.scheduledStart, start), lt(visits.scheduledStart, end)));
        const due = await tx
          .select({ title: tasks.title, at: tasks.dueAt })
          .from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.assigneeMembershipId, m.membershipId), eq(tasks.status, 'open'), lte(tasks.dueAt, end)))
          .orderBy(asc(tasks.dueAt))
          .limit(10);
        const [appr] = hasPermission(m.role, 'approvals.decide')
          ? await tx.select({ n: sql<number>`count(*)::int` }).from(approvalRequests).where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.status, 'pending'), or(isNull(approvalRequests.expiresAt), gte(approvalRequests.expiresAt, new Date()))))
          : [undefined];
        return { todays, teamVisits: team?.n ?? null, due, approvals: appr?.n ?? 0 };
      });
      const attention = hasPermission(m.role, 'crm.account.read') ? await this.attention.list(auth, { limit: 5 }) : [];
      if (!data.todays.length && !data.due.length && !attention.length && !data.approvals && !data.teamVisits) continue;

      const lines: string[] = [];
      if (data.todays.length) lines.push(`زياراتك اليوم (${data.todays.length}):`, ...data.todays.map((v) => `• ${hhmm(v.at)} — ${v.name}`));
      if (data.teamVisits) lines.push(`زيارات الفريق اليوم: ${data.teamVisits}`);
      if (data.due.length) lines.push(`مهام مستحقة أو متأخرة (${data.due.length}):`, ...data.due.map((t) => `• ${t.title}`));
      if (attention.length) lines.push(`يحتاج انتباهك (${attention.length}):`, ...attention.map((a) => `• ${a.accountName ?? a.detail}`));
      if (data.approvals) lines.push(`طلبات بانتظار موافقتك: ${data.approvals}`);
      const links = [
        ...(data.todays.length ? [{ label: 'يومي', href: '/field' }] : []),
        ...(data.due.length ? [{ label: 'المهام', href: '/tasks' }] : []),
        ...(attention.length ? [{ label: 'الرئيسية', href: '/home' }] : []),
        ...(data.approvals ? [{ label: 'الموافقات', href: '/approvals' }] : []),
      ];
      const title = `صباح الخير ${m.fullName.split(' ')[0]}: ${data.todays.length} زيارات و${data.due.length} مهام اليوم`;
      if (await this.deliver(tenantId, m, job.email, { kind: 'morning_brief', title, body: lines.join('\n'), links })) emailed++;
      notified++;
    }
    return { status: 'succeeded', detail: { notified, emailed } };
  }

  private async visitBriefs(tenantId: string, job: JobRow): Promise<Outcome> {
    if (!this.runtime.providerReady) return { status: 'skipped', detail: { reason: 'AI_NOT_CONFIGURED' } };
    const { start, end } = todayRange();
    const pending = await this.db.run({ tenantId }, (tx) =>
      tx
        .select({ id: visits.id, rep: visits.repMembershipId })
        .from(visits)
        .where(and(
          eq(visits.tenantId, tenantId), eq(visits.status, 'scheduled'), gte(visits.scheduledStart, start), lt(visits.scheduledStart, end),
          sql`NOT EXISTS (SELECT 1 FROM ${visitBriefs} b WHERE b.tenant_id = ${visits.tenantId} AND b.visit_id = ${visits.id})`,
        ))
        .orderBy(asc(visits.scheduledStart))
        .limit(MAX_BRIEFS_PER_RUN),
    );
    if (!pending.length) return { status: 'succeeded', detail: { prepared: 0 } };
    const people = new Map((await this.members(tenantId)).map((m) => [m.membershipId, m]));
    const perRep = new Map<string, number>();
    let failed = 0;
    let stopped: string | null = null;
    for (const v of pending) {
      const m = people.get(v.rep);
      if (!m || !hasPermission(m.role, 'ai.use')) continue;
      try {
        await this.agents.visitBrief(this.authFor(tenantId, m), v.id);
        perRep.set(v.rep, (perRep.get(v.rep) ?? 0) + 1);
      } catch (e) {
        const code = e instanceof AppError ? e.code : 'AI_ERROR';
        if (['AI_BUDGET_EXCEEDED', 'AI_DISABLED', 'AI_AGENT_DISABLED', 'AI_NOT_CONFIGURED'].includes(code)) {
          stopped = code;
          break;
        }
        failed++;
      }
    }
    for (const [rep, n] of perRep) {
      await this.deliver(tenantId, people.get(rep)!, job.email, {
        kind: 'visit_briefs', title: `جهّز راكان بطاقات ${n} من زياراتك اليوم`, body: 'افتح الزيارة لترى بطاقة التحضير: لماذا هذا العميل، أهداف الزيارة، الأسئلة المقترحة.',
        links: [{ label: 'يومي', href: '/field' }],
      });
    }
    const prepared = [...perRep.values()].reduce((a, b) => a + b, 0);
    return { status: prepared || !failed ? (stopped && !prepared ? 'skipped' : 'succeeded') : 'failed', detail: { prepared, failed, ...(stopped ? { stopped } : {}) } };
  }

  private async weeklyCoach(tenantId: string, job: JobRow): Promise<Outcome> {
    if (!this.runtime.providerReady) return { status: 'skipped', detail: { reason: 'AI_NOT_CONFIGURED' } };
    const all = await this.members(tenantId, ['owner', 'manager', 'rep']);
    const reps = all.filter((m) => m.role === 'rep');
    if (!reps.length) return { status: 'skipped', detail: { reason: 'NO_REPS' } };
    const leads = all.filter((m) => hasPermission(m.role, 'reports.read'));
    let reports = 0;
    let stopped: string | null = null;
    for (const rep of reps) {
      try {
        const r = await this.coach.generate(this.authFor(tenantId, rep), { days: 7 }, 'schedule');
        reports++;
        const link = [{ label: 'التقرير', href: `/coach?report=${r.id}` }];
        await this.deliver(tenantId, rep, job.email, { kind: 'coach_report', title: 'تقرير المدرب الأسبوعي جاهز', body: r.headline, links: link });
        for (const l of leads) await this.deliver(tenantId, l, job.email, { kind: 'coach_report', title: `تقرير المدرب الأسبوعي: ${rep.fullName}`, body: r.headline, links: link });
      } catch (e) {
        stopped = e instanceof AppError ? e.code : 'AI_ERROR';
        if (['AI_BUDGET_EXCEEDED', 'AI_DISABLED', 'AI_AGENT_DISABLED', 'AI_NOT_CONFIGURED'].includes(stopped)) break;
      }
    }
    return { status: reports ? 'succeeded' : 'failed', detail: { reports, ...(stopped ? { stopped } : {}) } };
  }
}
