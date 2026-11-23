import { Injectable } from '@nestjs/common';
import { proposals, tenants } from '@rakan/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { badRequest, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../field/storage.service';
import { sniff } from './attachments.service';

export const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
type LogoMeta = { mimeType: string; sizeBytes: number; updatedAt: string };

/**
 * The company logo, shown on proposals (print/PDF and the customer page).
 * Raster images only (no SVG, which can carry scripts), content-checked, encrypted like other files.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private key(tenantId: string) {
    return `${tenantId}/branding/logo`;
  }

  async meta(tenantId: string): Promise<LogoMeta | null> {
    const [t] = await this.db.run({ tenantId }, (tx) => tx.select({ s: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)));
    return ((t?.s as { logo?: LogoMeta } | undefined)?.logo) ?? null;
  }

  async get(tenantId: string): Promise<{ data: Buffer; mimeType: string }> {
    const m = await this.meta(tenantId);
    if (!m) throw notFound('Logo');
    return { data: await this.storage.get(tenantId, this.key(tenantId)), mimeType: m.mimeType };
  }

  async set(auth: TenantAuthContext, file: { buffer: Buffer; originalname: string; size: number } | undefined, meta: RequestMeta): Promise<{ logo: LogoMeta }> {
    if (!file?.buffer?.length) throw badRequest('NO_FILE', 'No file was received');
    if (file.size > LOGO_MAX_BYTES) throw badRequest('LOGO_TOO_LARGE', 'The logo must be 512 KB or less');
    const mimeType = sniff(file.buffer, file.originalname);
    if (!mimeType || !LOGO_TYPES.includes(mimeType)) throw badRequest('ATTACHMENT_TYPE_NOT_ALLOWED', 'PNG, JPEG or WebP only');
    await this.storage.put(auth.tenantId, this.key(auth.tenantId), file.buffer);
    const logo: LogoMeta = { mimeType, sizeBytes: file.size, updatedAt: new Date().toISOString() };
    await this.db.tenant(auth, async (tx) => {
      await tx.update(tenants).set({ settings: sql`${tenants.settings} || ${JSON.stringify({ logo })}::jsonb`, updatedAt: new Date() }).where(eq(tenants.id, auth.tenantId));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'tenant.logo.set', entityType: 'tenant', entityId: auth.tenantId, after: logo, meta });
    });
    return { logo };
  }

  async remove(auth: TenantAuthContext, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth, async (tx) => {
      await tx.update(tenants).set({ settings: sql`${tenants.settings} - 'logo'`, updatedAt: new Date() }).where(eq(tenants.id, auth.tenantId));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'tenant.logo.remove', entityType: 'tenant', entityId: auth.tenantId, meta });
    });
    await this.storage.remove(auth.tenantId, this.key(auth.tenantId));
  }

  /** For the customer link: only a proposal that was actually sent exposes its company's logo. */
  async forProposal(tenantId: string, proposalId: string): Promise<{ data: Buffer; mimeType: string }> {
    const [p] = await this.db.run({ tenantId }, (tx) =>
      tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId), inArray(proposals.status, ['sent', 'accepted', 'declined']))),
    );
    if (!p) throw notFound('Logo');
    return this.get(tenantId);
  }
}
