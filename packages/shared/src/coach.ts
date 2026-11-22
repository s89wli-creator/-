import { z } from 'zod';

// ---------------------------------------------------------------- Sales Coach

/** Activity numbers per rep, computed by code for a period (never by the model). */
export const COACH_METRICS = [
  'visits_planned', 'visits_completed', 'visit_completion_pct', 'visits_interested', 'avg_interest',
  'tasks_done', 'tasks_overdue', 'opps_created', 'deals_won', 'won_amount', 'deals_lost',
  'proposals_sent', 'proposals_accepted', 'hot_accounts_neglected',
] as const;
export type CoachMetric = (typeof COACH_METRICS)[number];
export type CoachMetrics = Record<CoachMetric, number>;

export const COACH_PERIODS = [7, 30] as const;
export const coachQuerySchema = z.object({ days: z.coerce.number().int().refine((d) => d === 7 || d === 30).default(7) });
export const coachReportRequestSchema = z.object({
  membershipId: z.string().uuid().optional(),
  days: z.union([z.literal(7), z.literal(30)]).default(7),
});
export const coachReportListQuerySchema = z.object({ membershipId: z.string().uuid().optional() });

export interface CoachMemberMetricsDto { membershipId: string; name: string; role: string; metrics: CoachMetrics }
export interface CoachTeamDto { from: string; to: string; days: number; members: CoachMemberMetricsDto[]; median: CoachMetrics }

export interface CoachPointDto { text: string; metric: CoachMetric; action?: string }
export interface CoachReportDto {
  id: string; membershipId: string; memberName: string; from: string; to: string; metrics: CoachMetrics; team: CoachMetrics;
  headline: string; strengths: CoachPointDto[]; improvements: CoachPointDto[];
  objectionTips: { objection: string; tip: string; ref: string; refLabel: string }[];
  dropped: { text: string; reason: string }[]; trigger: 'user' | 'schedule'; agentRunId: string | null; createdAt: string;
}
export type CoachReportSummaryDto = Pick<CoachReportDto, 'id' | 'membershipId' | 'memberName' | 'from' | 'to' | 'headline' | 'trigger' | 'createdAt'>;

// ---------------------------------------------------------------- Scheduled agents

export const JOBS = ['morning_brief', 'visit_briefs', 'weekly_coach'] as const;
export type JobKeyDto = (typeof JOBS)[number];
/** Jobs that call the AI provider (cost, budget). */
export const AI_JOBS: readonly JobKeyDto[] = ['visit_briefs', 'weekly_coach'];

export const jobUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  email: z.boolean().optional(),
});

export interface JobDto {
  job: JobKeyDto; enabled: boolean; hour: number; minute: number; days: number[]; email: boolean; usesAi: boolean;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: 'succeeded' | 'failed' | 'skipped' | null; lastDetail: Record<string, unknown> | null;
}
export interface JobRunDto {
  id: number; job: JobKeyDto; trigger: 'schedule' | 'manual'; triggeredByName: string | null; status: 'succeeded' | 'failed' | 'skipped';
  detail: Record<string, unknown>; startedAt: string; finishedAt: string;
}

// ---------------------------------------------------------------- Notifications

export interface NotificationDto {
  id: string; kind: string; title: string; body: string; links: { label: string; href: string }[]; readAt: string | null; createdAt: string;
}
export interface NotificationListDto { items: NotificationDto[]; unread: number }
