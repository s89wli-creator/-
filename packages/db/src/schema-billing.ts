import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0013_billing.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export type BillingStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'canceled';
export const billingInvoices = pgTable('billing_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  number: text('number').notNull(),
  planId: uuid('plan_id').notNull(),
  planKey: text('plan_key').notNull(),
  planName: text('plan_name').notNull(),
  period: text('period').$type<'month' | 'year'>().notNull(),
  subtotalHalalas: integer('subtotal_halalas').notNull(),
  vatHalalas: integer('vat_halalas').notNull(),
  totalHalalas: integer('total_halalas').notNull(),
  currency: text('currency').notNull().default('SAR'),
  status: text('status').$type<BillingStatus>().notNull().default('pending'),
  provider: text('provider').notNull(),
  providerInvoiceId: text('provider_invoice_id'),
  providerPaymentId: text('provider_payment_id'),
  providerStatus: text('provider_status'),
  paymentUrl: text('payment_url'),
  periodStart: ts('period_start').notNull(),
  periodEnd: ts('period_end').notNull(),
  paidAt: ts('paid_at'),
  failureReason: text('failure_reason'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const billingEvents = pgTable('billing_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  type: text('type').notNull(),
  ref: text('ref'),
  live: boolean('live'),
  outcome: text('outcome'),
  receivedAt: ts('received_at').notNull().defaultNow(),
});
