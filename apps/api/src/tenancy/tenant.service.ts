import { Injectable } from '@nestjs/common';
import { tenants, type Tx } from '@rakan/db';
import type { TenantDto, TenantSettingsInput } from '@rakan/shared';
import { eq } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';

type TenantRow = typeof tenants.$inferSelect;

const toDto = (t: TenantRow): TenantDto => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  legalName: t.legalName,
  crNumber: t.crNumber,
  vatNumber: t.vatNumber,
  industry: t.industry,
  timezone: t.timezone,
  defaultLocale: t.defaultLocale,
  status: t.status,
  settings: t.settings,
});

@Injectable()
export class TenantService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // `tenants` is a platform table (no RLS): always filter by the caller's active tenant id.
  private async load(tx: Tx, tenantId: string): Promise<TenantRow> {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw notFound('Company');
    return t;
  }

  get(auth: TenantAuthContext): Promise<TenantDto> {
    return this.db.tenant(auth, async (tx) => toDto(await this.load(tx, auth.tenantId)));
  }

  update(auth: TenantAuthContext, input: TenantSettingsInput, meta: RequestMeta): Promise<TenantDto> {
    return this.db.tenant(auth, async (tx) => {
      const before = await this.load(tx, auth.tenantId);
      const { settings, ...fields } = input;
      const [after] = await tx
        .update(tenants)
        .set({
          ...fields,
          ...(settings ? { settings: { ...before.settings, ...settings } } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, auth.tenantId))
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'tenant.update',
        entityType: 'tenant',
        entityId: auth.tenantId,
        before: toDto(before),
        after: toDto(after!),
        meta,
      });
      return toDto(after!);
    });
  }
}
