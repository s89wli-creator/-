import { Injectable } from '@nestjs/common';
import { brainItems, coachReports, meetingInsights, memberships, users, visits, type Tx } from '@rakan/db';
import {
  COACH_METRICS, hasPermission, type CoachMetric, type CoachMetrics, type CoachPointDto, type CoachReportDto, type CoachReportSummaryDto, type CoachTeamDto,
} from '@rakan/shared';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, notFound } from '../common/errors';
import { BASE_RULES, untrusted } from '../ai/guards';
import { AiRuntimeService } from '../ai/runtime.service';

const DAY = 86400_000;
const RIYADH_OFFSET_MS = 3 * 3600_000; // UTC+3 all year (no daylight saving)

/** Period of `days` days ending at the start of today (Riyadh): whole days only. */
export function periodFor(days: number, now = new Date()): { from: Date; to: Date; fromDate: string; toDate: string } {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const todayStartUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - RIYADH_OFFSET_MS;
  const to = new Date(todayStartUtc);
  const from = new Date(todayStartUtc - days * DAY);
  const iso = (d: Date) => new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
  return { from, to, fromDate: iso(from), toDate: iso(new Date(to.getTime() - 1)) };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 100) / 100;
};

/** Numbers written in a coaching sentence (Arabic-Indic or Latin digits). */
export function numbersIn(text: string): number[] {
  const latin = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٫/g, '.').replace(/(\d),(\d{3})/g, '$1$2');
  return [...latin.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

const metricEnum = z.enum(COACH_METRICS);
const coachSchema = z.object({
  headline: z.string().min(2).max(300),
  strengths: z.array(z.object({ text: z.string().max(400), metric: z.string() })).max(4),
  improvements: z.array(z.object({ text: z.string().max(400), metric: z.string(), action: z.string().max(300) })).max(4),
  objectionTips: z.array(z.object({ objection: z.string().max(200), tip: z.string().max(400), ref: z.string() })).max(4),
});

/**
 * Sales Coach.
 * - Activity numbers per rep come from the database (visits, tasks, deals, proposals) — the model never computes them.
 * - The model writes coaching points tied to one of those numbers; a point is dropped when its metric is unknown or
 *   when it quotes a number that is not in the rep's or team's figures. Objection tips must cite an approved
 *   Sales Brain objection answer.
 * - Reps see their own numbers and reports; owners, managers and read-only viewers see the team (reports.read).
 */
@Injectable()
export class CoachService {
  constructor(
    private readonly db: DbService,
    private readonly runtime: AiRuntimeService,
  ) {}

  private async members(tx: Tx, tenantId: string, only?: string) {
    return tx
      .select({ id: memberships.id, userId: memberships.userId, role: memberships.role, name: users.fullName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active'), inArray(memberships.role, ['owner', 'manager', 'rep']), only ? eq(memberships.id, only) : undefined))
      .orderBy(users.fullName);
  }

  /** All activity numbers for the given members over [from, to). */
  async metrics(tx: Tx, tenantId: string, ids: string[], from: Date, to: Date): Promise<Map<string, CoachMetrics>> {
    const out = new Map<string, CoachMetrics>();
    if (!ids.length) return out;
    const r = await tx.execute(sql`
      SELECT m.id,
        (SELECT count(*) FROM visits v WHERE v.tenant_id = m.tenant_id AND v.rep_membership_id = m.id AND v.status <> 'cancelled'
           AND v.scheduled_start >= ${from} AND v.scheduled_start < ${to})::int AS visits_planned,
        (SELECT count(*) FROM visits v WHERE v.tenant_id = m.tenant_id AND v.rep_membership_id = m.id AND v.status = 'completed'
           AND v.check_out_at >= ${from} AND v.check_out_at < ${to})::int AS visits_completed,
        (SELECT count(*) FROM visits v WHERE v.tenant_id = m.tenant_id AND v.rep_membership_id = m.id AND v.status = 'completed' AND v.outcome = 'interested'
           AND v.check_out_at >= ${from} AND v.check_out_at < ${to})::int AS visits_interested,
        (SELECT coalesce(round(avg(v.interest_level)::numeric, 1), 0) FROM visits v WHERE v.tenant_id = m.tenant_id AND v.rep_membership_id = m.id
           AND v.status = 'completed' AND v.interest_level IS NOT NULL AND v.check_out_at >= ${from} AND v.check_out_at < ${to})::float AS avg_interest,
        (SELECT count(*) FROM tasks t WHERE t.tenant_id = m.tenant_id AND t.assignee_membership_id = m.id AND t.status = 'done'
           AND t.completed_at >= ${from} AND t.completed_at < ${to})::int AS tasks_done,
        (SELECT count(*) FROM tasks t WHERE t.tenant_id = m.tenant_id AND t.assignee_membership_id = m.id AND t.status = 'open' AND t.due_at < now())::int AS tasks_overdue,
        (SELECT count(*) FROM opportunities o WHERE o.tenant_id = m.tenant_id AND o.owner_membership_id = m.id AND o.deleted_at IS NULL
           AND o.created_at >= ${from} AND o.created_at < ${to})::int AS opps_created,
        (SELECT count(DISTINCT o.id) FROM opportunity_stage_history h
           JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.id = h.to_stage_id
           JOIN opportunities o ON o.tenant_id = h.tenant_id AND o.id = h.opportunity_id
           WHERE h.tenant_id = m.tenant_id AND o.owner_membership_id = m.id AND s.category = 'won' AND h.changed_at >= ${from} AND h.changed_at < ${to})::int AS deals_won,
        (SELECT coalesce(sum(o.amount), 0) FROM opportunities o WHERE o.tenant_id = m.tenant_id AND o.owner_membership_id = m.id AND o.id IN (
           SELECT h.opportunity_id FROM opportunity_stage_history h JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.id = h.to_stage_id
           WHERE h.tenant_id = m.tenant_id AND s.category = 'won' AND h.changed_at >= ${from} AND h.changed_at < ${to}))::float AS won_amount,
        (SELECT count(DISTINCT o.id) FROM opportunity_stage_history h
           JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.id = h.to_stage_id
           JOIN opportunities o ON o.tenant_id = h.tenant_id AND o.id = h.opportunity_id
           WHERE h.tenant_id = m.tenant_id AND o.owner_membership_id = m.id AND s.category = 'lost' AND h.changed_at >= ${from} AND h.changed_at < ${to})::int AS deals_lost,
        (SELECT count(*) FROM proposals p WHERE p.tenant_id = m.tenant_id AND p.owner_user_id = m.user_id AND p.sent_at >= ${from} AND p.sent_at < ${to})::int AS proposals_sent,
        (SELECT count(*) FROM proposals p WHERE p.tenant_id = m.tenant_id AND p.owner_user_id = m.user_id AND p.status = 'accepted'
           AND p.decided_at >= ${from} AND p.decided_at < ${to})::int AS proposals_accepted,
        (SELECT count(*) FROM accounts a WHERE a.tenant_id = m.tenant_id AND a.owner_membership_id = m.id AND a.deleted_at IS NULL AND a.score_tier IN ('A','B')
           AND (a.last_activity_at IS NULL OR a.last_activity_at < now() - interval '21 days'))::int AS hot_accounts_neglected
      FROM memberships m
      WHERE m.tenant_id = ${tenantId} AND m.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    for (const row of r.rows as Record<string, number | string>[]) {
      const m = Object.fromEntries(COACH_METRICS.map((k) => [k, Number(row[k] ?? 0)])) as CoachMetrics;
      m.visit_completion_pct = m.visits_planned ? Math.round((m.visits_completed / m.visits_planned) * 100) : 0;
      out.set(String(row.id), m);
    }
    return out;
  }

  private teamMedian(all: { role: string; metrics: CoachMetrics }[]): CoachMetrics {
    const reps = all.filter((x) => x.role === 'rep');
    const base = reps.length ? reps : all;
    return Object.fromEntries(COACH_METRICS.map((k) => [k, median(base.map((x) => x.metrics[k]))])) as CoachMetrics;
  }

  async team(auth: TenantAuthContext, days: number): Promise<CoachTeamDto> {
    const p = periodFor(days);
    return this.db.tenant(auth, async (tx) => {
      const ms = await this.members(tx, auth.tenantId);
      const metrics = await this.metrics(tx, auth.tenantId, ms.map((m) => m.id), p.from, p.to);
      const members = ms.map((m) => ({ membershipId: m.id, name: m.name, role: m.role, metrics: metrics.get(m.id)! }));
      return { from: p.fromDate, to: p.toDate, days, members, median: this.teamMedian(members) };
    });
  }

  /** The caller's own numbers (any member), with the team median for comparison. */
  async mine(auth: TenantAuthContext, days: number): Promise<CoachTeamDto> {
    const t = await this.team(auth, days);
    return { ...t, members: t.members.filter((m) => m.membershipId === auth.membershipId) };
  }

  private canSeeTeam(auth: TenantAuthContext): boolean {
    return hasPermission(auth.role, 'reports.read');
  }

  /** Generates a coaching report with the model (budgeted, logged). */
  async generate(auth: TenantAuthContext, input: { membershipId?: string; days: number }, trigger: 'user' | 'schedule' = 'user'): Promise<CoachReportDto> {
    const subject = input.membershipId ?? auth.membershipId;
    if (subject !== auth.membershipId && !this.canSeeTeam(auth)) throw notFound('Member');
    const p = periodFor(input.days);
    const prep = await this.db.tenant(auth, async (tx) => {
      const all = await this.members(tx, auth.tenantId);
      const me = all.find((m) => m.id === subject);
      if (!me) throw notFound('Member');
      const metrics = await this.metrics(tx, auth.tenantId, all.map((m) => m.id), p.from, p.to);
      const team = this.teamMedian(all.map((m) => ({ role: m.role, metrics: metrics.get(m.id)! })));
      const objections = await tx
        .select({ id: brainItems.id, title: brainItems.title, fields: brainItems.fields })
        .from(brainItems)
        .where(and(eq(brainItems.tenantId, auth.tenantId), eq(brainItems.section, 'objections'), eq(brainItems.status, 'approved')))
        .limit(20);
      const insights = await tx
        .select({ facts: meetingInsights.statedFacts })
        .from(meetingInsights)
        .innerJoin(visits, and(eq(visits.tenantId, meetingInsights.tenantId), eq(visits.id, meetingInsights.visitId)))
        .where(and(eq(meetingInsights.tenantId, auth.tenantId), eq(visits.repMembershipId, subject), gte(meetingInsights.createdAt, p.from), lt(meetingInsights.createdAt, p.to)))
        .orderBy(desc(meetingInsights.createdAt))
        .limit(20);
      const heard = insights
        .flatMap((i) => (i.facts as { type?: string; value?: string; quote?: string }[]))
        .filter((f) => f.type === 'objection' || f.type === 'competitor')
        .map((f) => `- ${f.value ?? ''} «${(f.quote ?? '').slice(0, 160)}»`)
        .slice(0, 15);
      return { me, metrics: metrics.get(subject)!, team, objections, heard };
    });
    if (!this.runtime.providerReady) throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');

    const refs = new Map(prep.objections.map((o) => [`brain:${o.id}`, o]));
    const table = COACH_METRICS.map((k) => `| ${k} | ${prep.metrics[k]} | ${prep.team[k]} |`).join('\n');
    const objText = prep.objections.length
      ? prep.objections.map((o) => {
        const f = o.fields as { objection?: string; response?: string };
        return `- [brain:${o.id}] الاعتراض: ${f.objection ?? o.title} — الرد المعتمد: ${f.response ?? ''}`;
      }).join('\n')
      : 'غير متوفر';

    const { output } = await this.runtime.run(auth, 'sales_coach', { entityType: 'membership', entityId: subject, input: { days: input.days }, trigger }, async (ctx) => {
      const out = await ctx.call({
        system: `${BASE_RULES}
أنت مدرب مبيعات داخل الشركة. اكتب تقييماً أسبوعياً بنّاءً ومحدداً لـ${prep.me.name} عن الفترة من ${p.fromDate} إلى ${p.toDate}.
- اعتمد فقط على جدول الأرقام. كل نقطة مرتبطة بمقياس واحد (metric) من الجدول، ولا تذكر أي رقم غير موجود في الجدول.
- improvements: كل نقطة معها action عملي واحد للأسبوع القادم.
- objectionTips: فقط إذا ظهرت اعتراضات في الاجتماعات ووُجد لها رد معتمد؛ ref يجب أن يكون أحد مراجع [brain:...] المعطاة.
- إذا كانت الأرقام صفراً أو قليلة فقل ذلك بوضوح ولا تبالغ.
- النبرة: زميل خبير ومحترم، بلا لوم.`,
        prompt: `## الأرقام (المقياس | ${prep.me.name} | وسيط الفريق)\n| metric | rep | team |\n|---|---|---|\n${table}\n\n## الردود المعتمدة على الاعتراضات\n${objText}\n\n## اعتراضات سُمعت في اجتماعات الفترة (نصوص من الملاحظات)\n${prep.heard.length ? untrusted('meeting_objections', prep.heard.join('\n')) : 'لا يوجد'}`,
        effort: 'medium',
        schema: coachSchema,
      });

      // Validation: metric keys exist; quoted numbers come from the figures; objection answers cite approved items.
      const allowed = new Set<number>([...Object.values(prep.metrics), ...Object.values(prep.team), input.days]);
      const dropped: { text: string; reason: string }[] = [];
      const numbersOk = (t: string) => numbersIn(t).every((n) => allowed.has(n));
      const keep = <T extends { text: string; metric: string; action?: string }>(xs: T[]): CoachPointDto[] =>
        xs.flatMap((x) => {
          const metric = metricEnum.safeParse(x.metric);
          if (!metric.success) return (dropped.push({ text: x.text, reason: 'unknown_metric' }), []);
          if (!numbersOk(`${x.text} ${x.action ?? ''}`)) return (dropped.push({ text: x.text, reason: 'unsupported_number' }), []);
          return [{ text: x.text, metric: metric.data as CoachMetric, ...(x.action ? { action: x.action } : {}) }];
        });
      const strengths = keep(out.strengths);
      const improvements = keep(out.improvements);
      const objectionTips = out.objectionTips.flatMap((o) => {
        const ref = o.ref.replace(/^\[|\]$/g, '');
        if (!refs.has(ref)) return (dropped.push({ text: o.tip, reason: 'no_approved_source' }), []);
        return [{ objection: o.objection, tip: o.tip, ref, refLabel: refs.get(ref)!.title }];
      });
      const headline = numbersOk(out.headline) ? out.headline : (dropped.push({ text: out.headline, reason: 'unsupported_number' }), '');
      await ctx.step('validation', 'sales_coach', { dropped: dropped.length });

      const row = await this.db.tenant(auth, async (tx) => {
        const [r] = await tx
          .insert(coachReports)
          .values({
            tenantId: auth.tenantId, membershipId: subject, periodFrom: p.fromDate, periodTo: p.toDate, metrics: prep.metrics, team: prep.team,
            output: { headline, strengths, improvements, objectionTips }, dropped, agentRunId: ctx.runId, trigger, requestedBy: auth.userId,
          })
          .returning();
        return r!;
      });
      return { output: this.dto(row, prep.me.name) };
    });
    return output;
  }

  private dto(r: typeof coachReports.$inferSelect, memberName: string): CoachReportDto {
    const o = r.output as Pick<CoachReportDto, 'headline' | 'strengths' | 'improvements' | 'objectionTips'>;
    return {
      id: r.id, membershipId: r.membershipId, memberName, from: r.periodFrom, to: r.periodTo, metrics: r.metrics as CoachMetrics, team: r.team as CoachMetrics,
      headline: o.headline, strengths: o.strengths, improvements: o.improvements, objectionTips: o.objectionTips, dropped: r.dropped,
      trigger: r.trigger, agentRunId: r.agentRunId, createdAt: r.createdAt.toISOString(),
    };
  }

  async reports(auth: TenantAuthContext, membershipId?: string): Promise<CoachReportSummaryDto[]> {
    const target = this.canSeeTeam(auth) ? membershipId : auth.membershipId;
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select({ r: coachReports, name: users.fullName })
        .from(coachReports)
        .innerJoin(memberships, and(eq(memberships.tenantId, coachReports.tenantId), eq(memberships.id, coachReports.membershipId)))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(coachReports.tenantId, auth.tenantId), target ? eq(coachReports.membershipId, target) : undefined))
        .orderBy(desc(coachReports.createdAt))
        .limit(100);
      return rows.map(({ r, name }) => {
        const d = this.dto(r, name);
        return { id: d.id, membershipId: d.membershipId, memberName: d.memberName, from: d.from, to: d.to, headline: d.headline, trigger: d.trigger, createdAt: d.createdAt };
      });
    });
  }

  async report(auth: TenantAuthContext, id: string): Promise<CoachReportDto> {
    return this.db.tenant(auth, async (tx) => {
      const [row] = await tx
        .select({ r: coachReports, name: users.fullName })
        .from(coachReports)
        .innerJoin(memberships, and(eq(memberships.tenantId, coachReports.tenantId), eq(memberships.id, coachReports.membershipId)))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(coachReports.tenantId, auth.tenantId), eq(coachReports.id, id)));
      if (!row || (row.r.membershipId !== auth.membershipId && !this.canSeeTeam(auth))) throw notFound('Report');
      return this.dto(row.r, row.name);
    });
  }
}
