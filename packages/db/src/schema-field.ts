import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0004_field.sql. */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const idempotencyKeys = pgTable('idempotency_keys', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  status: text('status').$type<'in_progress' | 'done'>().notNull().default('in_progress'),
  responseCode: integer('response_code'),
  responseBody: jsonb('response_body'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const visitRecordings = pgTable('visit_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  visitId: uuid('visit_id').notNull(),
  uploadedBy: uuid('uploaded_by'),
  consentConfirmed: boolean('consent_confirmed').notNull(),
  mimeType: text('mime_type').notNull(),
  totalChunks: integer('total_chunks').notNull(),
  receivedChunks: integer('received_chunks').array().notNull().default([]),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  durationSec: integer('duration_sec'),
  storageKey: text('storage_key'),
  status: text('status').$type<'uploading' | 'ready' | 'deleted'>().notNull().default('uploading'),
  transcript: text('transcript'),
  transcriptStatus: text('transcript_status').$type<'none' | 'pending' | 'ready' | 'failed' | 'manual'>().notNull().default('none'),
  deleteAfter: ts('delete_after').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
