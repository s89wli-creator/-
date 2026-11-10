import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0005_platform.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const inet = customType<{ data: string }>({ dataType: () => 'inet' });

export interface PlanLimits { users: number | null; aiMonthlyUsd: number | null; storageMb: number | null; recordingMinutes: number | null }

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: citext('key').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  priceSarMonthly: numeric('price_sar_monthly', { precision: 10, scale: 2, mode: 'number' }),
  limits: jsonb('limits').$type<PlanLimits>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  tenantId: uuid('tenant_id').primaryKey(),
  planId: uuid('plan_id').notNull(),
  trialEndsAt: ts('trial_ends_at'),
  currentPeriodEnd: ts('current_period_end'),
  notes: text('notes'),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const platformAudit = pgTable('platform_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  tenantId: uuid('tenant_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  createdAt: ts('created_at').notNull().default(sql`now()`),
});
