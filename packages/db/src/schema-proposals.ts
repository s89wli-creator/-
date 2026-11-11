import { date, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0010_proposals.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: 'number' });

export const proposalSequences = pgTable('proposal_sequences', {
  tenantId: uuid('tenant_id').primaryKey(),
  last: integer('last').notNull().default(0),
});

export type ProposalStatus = 'draft' | 'pending_approval' | 'sent' | 'accepted' | 'declined' | 'cancelled';
export const proposals = pgTable('proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  number: text('number').notNull(),
  accountId: uuid('account_id').notNull(),
  opportunityId: uuid('opportunity_id'),
  contactId: uuid('contact_id'),
  ownerUserId: uuid('owner_user_id'),
  title: text('title').notNull(),
  intro: text('intro').notNull().default(''),
  terms: text('terms').notNull().default(''),
  currency: text('currency').notNull().default('SAR'),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2, mode: 'number' }).notNull().default(15),
  subtotal: money('subtotal').notNull().default(0),
  discountTotal: money('discount_total').notNull().default(0),
  vatAmount: money('vat_amount').notNull().default(0),
  total: money('total').notNull().default(0),
  validUntil: date('valid_until', { mode: 'string' }).notNull(),
  status: text('status').$type<ProposalStatus>().notNull().default('draft'),
  version: integer('version').notNull().default(1),
  source: text('source').$type<'user' | 'agent'>().notNull().default('user'),
  agentRunId: uuid('agent_run_id'),
  approvalRequestId: uuid('approval_request_id'),
  shareTokenHash: text('share_token_hash'),
  shareTokenEnc: text('share_token_enc'),
  sentAt: ts('sent_at'),
  viewedAt: ts('viewed_at'),
  decidedAt: ts('decided_at'),
  decisionByName: text('decision_by_name'),
  decisionNote: text('decision_note'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const proposalItems = pgTable('proposal_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  sort: integer('sort').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  unit: text('unit'),
  quantity: numeric('quantity', { precision: 12, scale: 2, mode: 'number' }).notNull(),
  unitPrice: money('unit_price').notNull(),
  discountPct: numeric('discount_pct', { precision: 5, scale: 2, mode: 'number' }).notNull().default(0),
  lineTotal: money('line_total').notNull(),
  priceSource: text('price_source').$type<'price_list' | 'manual'>().notNull(),
  brainItemId: uuid('brain_item_id'),
  brainVersion: integer('brain_version'),
});
