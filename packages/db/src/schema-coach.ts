import { bigint, boolean, date, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0011_coach_scheduler.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  links: jsonb('links').$type<{ label: string; href: string }[]>().notNull().default([]),
  readAt: ts('read_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type JobKey = 'morning_brief' | 'visit_briefs' | 'weekly_coach';
export const scheduledJobs = pgTable('scheduled_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  job: text('job').$type<JobKey>().notNull(),
  enabled: boolean('enabled').notNull().default(false),
  hour: smallint('hour').notNull(),
  minute: smallint('minute').notNull().default(0),
  days: smallint('days').array().notNull(),
  email: boolean('email').notNull().default(false),
  nextRunAt: ts('next_run_at'),
  lastRunAt: ts('last_run_at'),
  lastStatus: text('last_status').$type<'succeeded' | 'failed' | 'skipped'>(),
  lastDetail: jsonb('last_detail').$type<Record<string, unknown>>(),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const jobRuns = pgTable('job_runs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  job: text('job').$type<JobKey>().notNull(),
  trigger: text('trigger').$type<'schedule' | 'manual'>().notNull(),
  triggeredBy: uuid('triggered_by'),
  status: text('status').$type<'succeeded' | 'failed' | 'skipped'>().notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  startedAt: ts('started_at').notNull(),
  finishedAt: ts('finished_at').notNull().defaultNow(),
});

export const coachReports = pgTable('coach_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  periodFrom: date('period_from', { mode: 'string' }).notNull(),
  periodTo: date('period_to', { mode: 'string' }).notNull(),
  metrics: jsonb('metrics').$type<Record<string, number>>().notNull(),
  team: jsonb('team').$type<Record<string, number>>().notNull(),
  output: jsonb('output').$type<Record<string, unknown>>().notNull(),
  dropped: jsonb('dropped').$type<{ text: string; reason: string }[]>().notNull().default([]),
  agentRunId: uuid('agent_run_id'),
  trigger: text('trigger').$type<'user' | 'schedule'>().notNull(),
  requestedBy: uuid('requested_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
