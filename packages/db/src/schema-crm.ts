import { sql } from 'drizzle-orm';
import {
  bigint, boolean, date, doublePrecision, integer, jsonb, numeric, pgTable, real, smallint, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

/** Mirrors migrations/0002_crm.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: 'number' });
const prob = (name: string) => numeric(name, { precision: 4, scale: 3, mode: 'number' });

export const tracks = pgTable('tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  trackId: uuid('track_id'),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pipelineStages = pgTable('pipeline_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  category: text('category').$type<'open' | 'won' | 'lost' | 'postponed'>().notNull(),
  winProbability: prob('win_probability'),
});

export const outcomeReasons = pgTable('outcome_reasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').$type<'win' | 'loss' | 'postpone' | 'disqualify'>().notNull(),
  label: text('label').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const customFieldDefs = pgTable('custom_field_defs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  entity: text('entity').$type<'account' | 'contact' | 'opportunity'>().notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type').$type<'text' | 'number' | 'date' | 'select' | 'boolean'>().notNull(),
  options: text('options').array(),
  trackId: uuid('track_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  trackId: uuid('track_id'),
  name: text('name').notNull(),
  nameNormalized: text('name_normalized').notNull(),
  legalName: text('legal_name'),
  crNumber: text('cr_number'),
  vatNumber: text('vat_number'),
  websiteDomain: text('website_domain'),
  phone: text('phone'),
  industry: text('industry'),
  sizeBand: text('size_band'),
  region: text('region'),
  city: text('city'),
  address: text('address'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  ownerMembershipId: uuid('owner_membership_id'),
  territoryId: uuid('territory_id'),
  status: text('status').notNull().default('active'),
  disqualifyReason: text('disqualify_reason'),
  leadSource: text('lead_source').notNull().default('manual'),
  leadSourceDetail: text('lead_source_detail'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  importJobId: uuid('import_job_id'),
  lastActivityAt: ts('last_activity_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  fullName: text('full_name').notNull(),
  jobTitle: text('job_title'),
  phoneEnc: text('phone_enc'),
  phoneHash: text('phone_hash'),
  emailEnc: text('email_enc'),
  emailHash: text('email_hash'),
  preferredChannel: text('preferred_channel'),
  isPrimary: boolean('is_primary').notNull().default(false),
  doNotContact: boolean('do_not_contact').notNull().default(false),
  dncReason: text('dnc_reason'),
  dncAt: ts('dnc_at'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const opportunities = pgTable('opportunities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  title: text('title').notNull(),
  ownerMembershipId: uuid('owner_membership_id'),
  amount: money('amount'),
  currency: text('currency').notNull().default('SAR'),
  expectedCloseDate: date('expected_close_date', { mode: 'string' }),
  outcomeReasonId: uuid('outcome_reason_id'),
  outcomeNote: text('outcome_note'),
  closedAt: ts('closed_at'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const opportunityStageHistory = pgTable('opportunity_stage_history', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  opportunityId: uuid('opportunity_id').notNull(),
  fromStageId: uuid('from_stage_id'),
  toStageId: uuid('to_stage_id').notNull(),
  changedByType: text('changed_by_type').$type<'user' | 'system_event' | 'agent_confirmed'>().notNull(),
  changedByUserId: uuid('changed_by_user_id'),
  evidence: jsonb('evidence'),
  changedAt: ts('changed_at').notNull().defaultNow(),
});

export const visits = pgTable('visits', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  opportunityId: uuid('opportunity_id'),
  repMembershipId: uuid('rep_membership_id').notNull(),
  purpose: text('purpose'),
  scheduledStart: ts('scheduled_start').notNull(),
  scheduledEnd: ts('scheduled_end'),
  status: text('status').$type<'scheduled' | 'in_progress' | 'completed' | 'cancelled'>().notNull().default('scheduled'),
  checkInAt: ts('check_in_at'),
  checkInLat: doublePrecision('check_in_lat'),
  checkInLng: doublePrecision('check_in_lng'),
  checkInAccuracyM: real('check_in_accuracy_m'),
  checkOutAt: ts('check_out_at'),
  checkOutLat: doublePrecision('check_out_lat'),
  checkOutLng: doublePrecision('check_out_lng'),
  outcome: text('outcome'),
  interestLevel: smallint('interest_level'),
  nextStep: text('next_step'),
  nextFollowUpAt: ts('next_follow_up_at'),
  notes: text('notes'),
  followUpTaskId: uuid('follow_up_task_id'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  type: text('type').notNull().default('todo'),
  priority: text('priority').$type<'low' | 'normal' | 'high'>().notNull().default('normal'),
  dueAt: ts('due_at'),
  assigneeMembershipId: uuid('assignee_membership_id'),
  accountId: uuid('account_id'),
  opportunityId: uuid('opportunity_id'),
  visitId: uuid('visit_id'),
  status: text('status').$type<'open' | 'done' | 'cancelled'>().notNull().default('open'),
  completedAt: ts('completed_at'),
  createdByType: text('created_by_type').$type<'user' | 'agent' | 'system'>().notNull().default('user'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  opportunityId: uuid('opportunity_id'),
  body: text('body').notNull(),
  authorUserId: uuid('author_user_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const activities = pgTable('activities', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  opportunityId: uuid('opportunity_id'),
  type: text('type').notNull(),
  actorType: text('actor_type').$type<'user' | 'agent' | 'system'>().notNull(),
  actorUserId: uuid('actor_user_id'),
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  summary: text('summary'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
});

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  entity: text('entity').$type<'account'>().notNull().default('account'),
  filename: text('filename').notNull(),
  headers: text('headers').array().notNull(),
  mapping: jsonb('mapping').$type<Record<string, string>>(),
  defaults: jsonb('defaults').$type<{ trackId?: string | null; ownerMembershipId?: string | null; leadSourceDetail?: string | null }>(),
  dataPermissionConfirmed: boolean('data_permission_confirmed').notNull().default(false),
  status: text('status').$type<'uploaded' | 'review' | 'completed' | 'failed' | 'cancelled'>().notNull().default('uploaded'),
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});

export const importRows = pgTable('import_rows', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  importJobId: uuid('import_job_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  raw: jsonb('raw').$type<Record<string, string>>().notNull(),
  normalized: jsonb('normalized').$type<Record<string, unknown>>(),
  errors: jsonb('errors').$type<{ field: string; code: string }[]>(),
  duplicateOf: uuid('duplicate_of'),
  duplicateReason: text('duplicate_reason'),
  inFileDuplicateOf: integer('in_file_duplicate_of'),
  resolution: text('resolution').$type<'create' | 'merge' | 'skip'>(),
  resultEntityId: uuid('result_entity_id'),
});
