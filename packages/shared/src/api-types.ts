import type { Permission, SystemRole } from './permissions';

export interface MeResponse {
  user: { id: string; email: string; fullName: string; locale: 'ar' | 'en'; isPlatformAdmin: boolean };
  activeTenant: { id: string; name: string; slug: string; role: SystemRole; permissions: Permission[] } | null;
  memberships: { tenantId: string; tenantName: string; role: SystemRole }[];
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface MemberDto {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  role: SystemRole;
  title: string | null;
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: SystemRole;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface TerritoryDto {
  id: string;
  name: string;
  regions: string[];
  cities: string[];
  memberIds: string[];
}

export interface AuditLogDto {
  id: number;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  legalName: string | null;
  crNumber: string | null;
  vatNumber: string | null;
  industry: string | null;
  timezone: string;
  defaultLocale: 'ar' | 'en';
  status: string;
  settings: Record<string, unknown>;
}
