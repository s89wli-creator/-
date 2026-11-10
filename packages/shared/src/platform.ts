import { z } from 'zod';

const limit = z.number().int().min(0).max(1_000_000).nullable();
export const planLimitsSchema = z.object({ users: limit, aiMonthlyUsd: limit, storageMb: limit, recordingMinutes: limit });
export const planSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,30}$/),
  nameAr: z.string().trim().min(1).max(60),
  nameEn: z.string().trim().min(1).max(60),
  priceSarMonthly: z.number().min(0).max(1_000_000).nullable(),
  limits: planLimitsSchema,
  isActive: z.boolean().default(true),
  sort: z.number().int().min(0).max(1000).default(0),
});
export const planUpdateSchema = planSchema.omit({ key: true }).partial();

export const TENANT_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const;
export const subscriptionUpdateSchema = z.object({
  planId: z.string().uuid().optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  trialEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
  currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});
export const tenantListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
});

export interface PlanLimitsDto { users: number | null; aiMonthlyUsd: number | null; storageMb: number | null; recordingMinutes: number | null }
export interface PlanDto {
  id: string; key: string; nameAr: string; nameEn: string; priceSarMonthly: number | null; limits: PlanLimitsDto;
  isActive: boolean; sort: number; tenants: number;
}
export interface UsageDto {
  activeUsers: number; pendingInvitations: number; accounts: number; visits30d: number;
  aiUsdMonth: number; aiRunsMonth: number; storageBytes: number; lastActivityAt: string | null;
}
export interface TenantAdminDto {
  id: string; name: string; slug: string; status: string; createdAt: string; ownerName: string | null; ownerEmail: string | null;
  plan: { id: string; key: string; nameAr: string; nameEn: string; priceSarMonthly: number | null; limits: PlanLimitsDto } | null;
  trialEndsAt: string | null; currentPeriodEnd: string | null; notes: string | null; usage: UsageDto;
  /** Limits at ≥ 80% (warn) or ≥ 100% (full) of the plan. */
  alerts: { metric: 'users' | 'ai' | 'storage'; level: 'warn' | 'full' }[];
}
export interface PlatformOverviewDto {
  tenants: { total: number; trial: number; active: number; suspended: number; cancelled: number; new30d: number };
  users: number; mrrSar: number; aiUsdMonth: number; storageBytes: number; trialsEndingSoon: number; alerts: number;
  byPlan: { key: string; nameAr: string; nameEn: string; tenants: number }[];
  topAiSpend: { id: string; name: string; aiUsdMonth: number }[];
}
export interface PlatformAuditDto {
  id: number; action: string; actorName: string | null; tenantId: string | null; tenantName: string | null;
  before: unknown; after: unknown; createdAt: string;
}
/** What a company sees about its own plan. */
export interface TenantPlanDto {
  plan: { key: string; nameAr: string; nameEn: string; priceSarMonthly: number | null; limits: PlanLimitsDto } | null;
  status: string; trialEndsAt: string | null; usage: UsageDto; alerts: TenantAdminDto['alerts'];
}
