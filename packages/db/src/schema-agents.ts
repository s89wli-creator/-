import { bigint, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0007_prospecting_assistant.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const prospectSearches = pgTable('prospect_searches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  query: text('query').notNull(),
  city: text('city'),
  source: text('source').$type<'web_search' | 'manual'>().notNull(),
  status: text('status').$type<'running' | 'done' | 'failed'>().notNull().default('running'),
  found: integer('found').notNull().default(0),
  dropped: jsonb('dropped').$type<{ name: string; reason: string }[]>().notNull().default([]),
  agentRunId: uuid('agent_run_id'),
  requestedBy: uuid('requested_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const prospects = pgTable('prospects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  searchId: uuid('search_id').notNull(),
  name: text('name').notNull(),
  websiteDomain: text('website_domain'),
  city: text('city'),
  region: text('region'),
  industry: text('industry'),
  phone: text('phone'),
  whyFit: text('why_fit').notNull(),
  fitEvidence: jsonb('fit_evidence').$type<{ text: string; ref: string; label: string }[]>().notNull().default([]),
  sourceUrl: text('source_url').notNull(),
  sourceTitle: text('source_title'),
  retrievedAt: ts('retrieved_at').notNull().defaultNow(),
  confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
  duplicateOfAccountId: uuid('duplicate_of_account_id'),
  status: text('status').$type<'pending_review' | 'accepted' | 'rejected'>().notNull().default('pending_review'),
  accountId: uuid('account_id'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  rejectReason: text('reject_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const assistantConversations = pgTable('assistant_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export interface ToolCallRecord { tool: string; input: unknown; ok: boolean; summary: string }
export const assistantMessages = pgTable('assistant_messages', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  role: text('role').$type<'user' | 'assistant'>().notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>().notNull().default([]),
  links: jsonb('links').$type<{ label: string; href: string }[]>().notNull().default([]),
  agentRunId: uuid('agent_run_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
