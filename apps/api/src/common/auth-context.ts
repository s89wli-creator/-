import type { Permission, SystemRole } from '@rakan/shared';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  fullName: string;
  /** Active tenant with an ACTIVE membership; null when the user has none. */
  tenantId: string | null;
  membershipId: string | null;
  role: SystemRole | null;
  permissions: readonly Permission[];
  /** Platform operator (Rakan staff). Grants the platform console only, never tenant data. */
  isPlatformAdmin?: boolean;
  /** Two-step verification is on for the user and was completed for this session. */
  mfaSession?: boolean;
  /** Status of the active company (trial | active | suspended | cancelled). */
  tenantStatus?: string | null;
}

/** AuthContext guaranteed to have an active tenant (set by PermissionsGuard). */
export interface TenantAuthContext extends AuthContext {
  tenantId: string;
  membershipId: string;
  role: SystemRole;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}
