import { sql } from 'drizzle-orm';
import { bigint, boolean, char, customType, integer, jsonb, numeric, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0003_ai.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const usd = (name: string) => numeric(name, { precision: 12, scale: 6, mode: 'number' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const mfaChallenges = pgTable('mfa_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const aiSettings = pgTable('ai_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 10, scale: 2, mode: 'number' }).notNull().default(20),
  agents: jsonb('agents').$type<Record<string, { enabled?: boolean }>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const aiUsage = pgTable('ai_usage', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  agentRunId: uuid('agent_run_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: usd('cost_usd').notNull().default(0),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
});

export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'awaiting_approval' | 'cancelled';
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  agent: text('agent').notNull(),
  triggerType: text('trigger_type').$type<'user' | 'schedule' | 'event'>().notNull(),
  triggeredBy: uuid('triggered_by'),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  status: text('status').$type<AgentRunStatus>().notNull().default('running'),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  output: jsonb('output'),
  error: jsonb('error').$type<{ code: string; message: string } | null>(),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: usd('cost_usd').notNull().default(0),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const agentSteps = pgTable('agent_steps', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  kind: text('kind').$type<'context' | 'model_call' | 'validation' | 'tool_call' | 'guard_block' | 'approval_wait' | 'error'>().notNull(),
  name: text('name'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'execution_failed';
export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  actionType: text('action_type').notNull(),
  toolName: text('tool_name').notNull(),
  risk: text('risk').$type<'EXTERNAL' | 'IRREVERSIBLE'>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  payloadHash: text('payload_hash').notNull(),
  summary: text('summary'),
  reason: text('reason'),
  sources: jsonb('sources'),
  confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
  requestedByType: text('requested_by_type').$type<'user' | 'agent'>().notNull(),
  requestedBy: uuid('requested_by'),
  agentRunId: uuid('agent_run_id'),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  executedAt: ts('executed_at'),
  executionResult: jsonb('execution_result'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const brainItems = pgTable('brain_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  section: text('section').notNull(),
  trackId: uuid('track_id'),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: text('status').$type<'draft' | 'pending_confirmation' | 'approved' | 'archived'>().notNull().default('draft'),
  sourceType: text('source_type').$type<'user_input' | 'document' | 'website'>().notNull().default('user_input'),
  sourceRef: text('source_ref'),
  version: integer('version').notNull().default(1),
  searchText: text('search_text').notNull().default(''),
  searchTsv: tsvector('search_tsv'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  updatedBy: uuid('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const brainItemVersions = pgTable('brain_item_versions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  brainItemId: uuid('brain_item_id').notNull(),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  fields: jsonb('fields').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull(),
  changedBy: uuid('changed_by'),
  changedAt: ts('changed_at').notNull().defaultNow(),
});

export const brainDocuments = pgTable('brain_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  filename: text('filename'),
  content: text('content').notNull(),
  trustLevel: text('trust_level').$type<'unverified' | 'approved' | 'suspicious'>().notNull().default('unverified'),
  injectionFlags: jsonb('injection_flags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  uploadedBy: uuid('uploaded_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const brainChunks = pgTable('brain_chunks', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  content: text('content').notNull(),
  searchText: text('search_text').notNull(),
  searchTsv: tsvector('search_tsv'),
});

export const scoringModels = pgTable('scoring_models', {
  tenantId: uuid('tenant_id').primaryKey(),
  weights: jsonb('weights').$type<Record<string, number>>().notNull(),
  tierThresholds: jsonb('tier_thresholds').$type<{ A: number; B: number; C: number }>().notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const leadScores = pgTable('lead_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  score: integer('score').notNull(),
  tier: char('tier', { length: 1 }).$type<'A' | 'B' | 'C' | 'D'>().notNull(),
  disqualified: boolean('disqualified').notNull().default(false),
  criteria: jsonb('criteria').$type<unknown[]>().notNull(),
  missingData: text('missing_data').array().notNull().default(sql`'{}'`),
  confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
  summary: text('summary'),
  modelVersion: integer('model_version').notNull(),
  agentRunId: uuid('agent_run_id'),
  reviewStatus: text('review_status').$type<'unreviewed' | 'accepted' | 'overridden'>().notNull().default('unreviewed'),
  overrideTier: char('override_tier', { length: 1 }),
  overrideNote: text('override_note'),
  reviewedBy: uuid('reviewed_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const visitBriefs = pgTable('visit_briefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  visitId: uuid('visit_id').notNull(),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  removed: jsonb('removed').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  agentRunId: uuid('agent_run_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const meetingInsights = pgTable('meeting_insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  visitId: uuid('visit_id').notNull(),
  summary: text('summary').notNull(),
  statedFacts: jsonb('stated_facts').$type<unknown[]>().notNull(),
  inferences: jsonb('inferences').$type<unknown[]>().notNull(),
  nextActions: jsonb('next_actions').$type<unknown[]>().notNull(),
  interestLevel: smallint('interest_level'),
  progressLikelihood: numeric('progress_likelihood', { precision: 4, scale: 3, mode: 'number' }),
  removed: jsonb('removed').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  agentRunId: uuid('agent_run_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const messageDrafts = pgTable('message_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  visitId: uuid('visit_id'),
  channel: text('channel').$type<'email' | 'whatsapp'>().notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  status: text('status').$type<'draft' | 'pending_approval' | 'approved' | 'sent' | 'rejected' | 'cancelled'>().notNull().default('draft'),
  forbiddenHits: text('forbidden_hits').array().notNull().default(sql`'{}'`),
  approvalRequestId: uuid('approval_request_id'),
  agentRunId: uuid('agent_run_id'),
  createdBy: uuid('created_by'),
  sentAt: ts('sent_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
