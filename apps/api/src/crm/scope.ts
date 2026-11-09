import { Injectable } from '@nestjs/common';
import { tenants, type Tx } from '@rakan/db';
import { eq } from 'drizzle-orm';
import type { TenantAuthContext } from '../common/auth-context';
import { forbidden, notFound } from '../common/errors';

/**
 * Record-level scope inside a tenant.
 * - owner / manager / readonly: whole company (readonly cannot write; enforced by permissions).
 * - rep: records assigned to them. With company setting repVisibility = 'all', reps may READ all
 *   accounts but still WRITE only their own.
 */
export interface RecordScope {
  restricted: boolean; // true => rep
  membershipId: string;
  readAll: boolean;
}

@Injectable()
export class ScopeService {
  async forRequest(tx: Tx, auth: TenantAuthContext): Promise<RecordScope> {
    if (auth.role !== 'rep') return { restricted: false, membershipId: auth.membershipId, readAll: true };
    const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, auth.tenantId));
    const readAll = (t?.settings as { repVisibility?: string } | undefined)?.repVisibility === 'all';
    return { restricted: true, membershipId: auth.membershipId, readAll };
  }
}

/** Owner-based check for an account-like record. Throws 404 when not readable (no existence leak). */
export function assertCanRead(scope: RecordScope, ownerMembershipId: string | null): void {
  if (!scope.restricted || scope.readAll) return;
  if (ownerMembershipId !== scope.membershipId) throw notFound();
}

export function assertCanWrite(scope: RecordScope, ownerMembershipId: string | null): void {
  if (!scope.restricted) return;
  if (ownerMembershipId !== scope.membershipId) {
    if (scope.readAll) throw forbidden('You can only modify records assigned to you');
    throw notFound();
  }
}
