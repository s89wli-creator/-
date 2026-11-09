import { sql } from 'drizzle-orm';
import {
  bigint, boolean, customType, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

/** Mirrors migrations/*.sql. Migrations are the source of truth for DDL; this file types queries. */

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const inet = customType<{ data: string }>({ dataType: () => 'inet' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash'),
  locale: text('locale').$type<'ar' | 'en'>().notNull().default('ar'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  emailVerifiedAt: ts('email_verified_at'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  disabledAt: ts('disabled_at'),
});

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: citext('slug').notNull(),
  legalName: text('legal_name'),
  crNumber: text('cr_number'),
  vatNumber: text('vat_number'),
  industry: text('industry'),
  country: text('country').notNull().default('SA'),
  timezone: text('timezone').notNull().default('Asia/Riyadh'),
  defaultLocale: text('default_locale').$type<'ar' | 'en'>().notNull().default('ar'),
  status: text('status').notNull().default('trial'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  activeTenantId: uuid('active_tenant_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  idleExpiresAt: ts('idle_expires_at').notNull(),
  absoluteExpiresAt: ts('absolute_expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type RoleKey = 'owner' | 'manager' | 'rep' | 'readonly';

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').$type<RoleKey>().notNull(),
  title: text('title'),
  status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  email: citext('email').notNull(),
  role: text('role').$type<RoleKey>().notNull(),
  title: text('title'),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const territories = pgTable('territories', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  regions: text('regions').array().notNull().default(sql`'{}'`),
  cities: text('cities').array().notNull().default(sql`'{}'`),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const territoryAssignments = pgTable(
  'territory_assignments',
  {
    tenantId: uuid('tenant_id').notNull(),
    territoryId: uuid('territory_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.territoryId, t.membershipId] })],
);

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id'),
  actorType: text('actor_type').$type<'user' | 'agent' | 'system' | 'platform_admin'>().notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
