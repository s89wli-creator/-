import { z } from 'zod';
import { SYSTEM_ROLES } from './permissions';

const email = z.string().trim().toLowerCase().email().max(254);
/** OWASP ASVS: min 12 chars, no composition rules, max 128 (argon2 input bound). */
export const passwordSchema = z.string().min(12).max(128);
const name = z.string().trim().min(2).max(120);

export const registerSchema = z.object({
  fullName: name,
  email,
  password: passwordSchema,
  companyName: name,
  locale: z.enum(['ar', 'en']).default('ar'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const switchTenantSchema = z.object({ tenantId: z.string().uuid() });

export const tenantSettingsSchema = z.object({
  name: name.optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  crNumber: z.string().trim().regex(/^\d{10}$/, 'CR number must be 10 digits').nullable().optional(),
  vatNumber: z.string().trim().regex(/^3\d{13}3$/, 'VAT number must be 15 digits starting and ending with 3').nullable().optional(),
  industry: z.string().trim().max(120).nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  defaultLocale: z.enum(['ar', 'en']).optional(),
  settings: z
    .object({
      repVisibility: z.enum(['assigned_only', 'all']).optional(),
      recordingEnabled: z.boolean().optional(),
      sessionIdleHours: z.number().int().min(1).max(72).optional(),
    })
    .optional(),
});
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;

export const roleKeySchema = z.enum(SYSTEM_ROLES);

export const inviteSchema = z.object({
  email,
  role: roleKeySchema,
  title: z.string().trim().max(120).optional(),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  fullName: name.optional(),
  password: passwordSchema.optional(),
});

export const updateMemberSchema = z.object({
  role: roleKeySchema.optional(),
  title: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const territorySchema = z.object({
  name: name,
  regions: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  cities: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
});
export type TerritoryInput = z.infer<typeof territorySchema>;

export const territoryAssignmentSchema = z.object({ membershipIds: z.array(z.string().uuid()).max(500) });

export const auditQuerySchema = z.object({
  action: z.string().max(100).optional(),
  entityType: z.string().max(60).optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Saudi regions (المناطق الإدارية) — reference list for territories. */
export const SAUDI_REGIONS = [
  'الرياض', 'مكة المكرمة', 'المدينة المنورة', 'القصيم', 'المنطقة الشرقية', 'عسير',
  'تبوك', 'حائل', 'الحدود الشمالية', 'جازان', 'نجران', 'الباحة', 'الجوف',
] as const;
