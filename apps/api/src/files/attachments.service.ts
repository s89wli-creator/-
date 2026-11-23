import { Injectable } from '@nestjs/common';
import { attachments, proposals, users, type AttachmentEntity, type Tx } from '@rakan/db';
import { ATTACHMENT_MAX_BYTES, hasPermission, type AttachmentDto, type Permission } from '@rakan/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from '../crm/accounts.service';
import { ActivityService } from '../crm/activity.service';
import { ScopeService } from '../crm/scope';
import { VisitsService } from '../crm/visits.service';
import { StorageService } from '../field/storage.service';
import { PlanService } from '../platform/plan.service';

const PERM: Record<AttachmentEntity, { read: Permission; write: Permission }> = {
  account: { read: 'crm.account.read', write: 'crm.account.write' },
  visit: { read: 'crm.visit.read', write: 'crm.visit.write' },
  proposal: { read: 'crm.proposal.read', write: 'crm.proposal.write' },
};

const ZIP_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The real type of a file, from its first bytes (the name and the browser's type are not trusted). */
export function sniff(data: Buffer, filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const head = data.subarray(0, 16);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1'].includes(ascii.slice(8, 12))) return 'image/heic';
  if (ascii.startsWith('PK\x03\x04') && ZIP_TYPES[ext]) return ZIP_TYPES[ext]!;
  if ((ext === 'csv' || ext === 'txt') && !data.subarray(0, 8192).includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, Math.min(data.length, 65536)));
      return ext === 'csv' ? 'text/csv' : 'text/plain';
    } catch {
      return null;
    }
  }
  return null;
}

export function cleanName(name: string): string {
  // Multer gives latin1-decoded names; recover UTF-8 (Arabic names).
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  const base = (utf8.includes('�') ? name : utf8).split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 200) || 'file';
}

/**
 * Files attached to a customer, a visit or a proposal.
 * - Who may see or add a file follows the record it belongs to (same permissions and rep scope).
 * - Content-checked types only; encrypted at rest per company; counted in the plan's storage limit.
 * - Deleting removes the file from storage immediately (the log keeps who/when/what name).
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: ScopeService,
    private readonly accounts: AccountsService,
    private readonly visits: VisitsService,
    private readonly storage: StorageService,
    private readonly plans: PlanService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  /** Checks access to the parent record and returns its customer. */
  private async parent(tx: Tx, auth: TenantAuthContext, type: AttachmentEntity, id: string, write: boolean): Promise<string> {
    if (!hasPermission(auth.role, write ? PERM[type].write : PERM[type].read)) throw notFound();
    const scope = await this.scopes.forRequest(tx, auth);
    if (type === 'account') return (await this.accounts.loadAccount(tx, auth, scope, id, write)).id;
    if (type === 'visit') return (await this.visits.load(tx, auth, scope, id, write)).accountId;
    const [p] = await tx.select({ accountId: proposals.accountId }).from(proposals).where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, id)));
    if (!p) throw notFound();
    await this.accounts.loadAccount(tx, auth, scope, p.accountId, write);
    return p.accountId;
  }

  private dto(r: typeof attachments.$inferSelect, by: string | null): AttachmentDto {
    return {
      id: r.id, entityType: r.entityType, entityId: r.entityId, filename: r.filename, mimeType: r.mimeType, sizeBytes: r.sizeBytes,
      uploadedByName: by, createdAt: r.createdAt.toISOString(),
    };
  }

  async list(auth: TenantAuthContext, type: AttachmentEntity, id: string): Promise<AttachmentDto[]> {
    return this.db.tenant(auth, async (tx) => {
      await this.parent(tx, auth, type, id, false);
      const rows = await tx
        .select({ a: attachments, by: users.fullName })
        .from(attachments)
        .leftJoin(users, eq(users.id, attachments.uploadedBy))
        .where(and(eq(attachments.tenantId, auth.tenantId), eq(attachments.entityType, type), eq(attachments.entityId, id), isNull(attachments.deletedAt)))
        .orderBy(desc(attachments.createdAt));
      return rows.map(({ a, by }) => this.dto(a, by));
    });
  }

  async upload(
    auth: TenantAuthContext, type: AttachmentEntity, entityId: string, file: { buffer: Buffer; originalname: string; size: number } | undefined, meta: RequestMeta,
  ): Promise<AttachmentDto> {
    if (!file?.buffer?.length) throw badRequest('NO_FILE', 'No file was received');
    if (file.size > ATTACHMENT_MAX_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'File too large');
    const filename = cleanName(file.originalname);
    const mimeType = sniff(file.buffer, filename);
    if (!mimeType) throw badRequest('ATTACHMENT_TYPE_NOT_ALLOWED', 'This file type is not accepted');
    const accountId = await this.db.tenant(auth, (tx) => this.parent(tx, auth, type, entityId, true));
    await this.plans.assertStorage(auth.tenantId, file.size);

    const id = randomUUID();
    const key = `${auth.tenantId}/attachments/${id}`;
    await this.storage.put(auth.tenantId, key, file.buffer);
    try {
      return await this.db.tenant(auth, async (tx) => {
        const [r] = await tx
          .insert(attachments)
          .values({
            id, tenantId: auth.tenantId, entityType: type, entityId, accountId, filename, mimeType, sizeBytes: file.size,
            sha256: createHash('sha256').update(file.buffer).digest('hex'), storageKey: key, uploadedBy: auth.userId,
          })
          .returning();
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'attachment.upload', entityType: type, entityId,
          after: { attachmentId: id, filename, mimeType, sizeBytes: file.size }, meta,
        });
        await this.activity.record(tx, { tenantId: auth.tenantId, accountId, type: 'attachment_added', actorType: 'user', actorUserId: auth.userId, refType: 'attachment', refId: id, summary: filename });
        return this.dto(r!, auth.fullName);
      });
    } catch (e) {
      await this.storage.remove(auth.tenantId, key).catch(() => undefined);
      throw e;
    }
  }

  private async load(tx: Tx, auth: TenantAuthContext, id: string, write: boolean) {
    const [a] = await tx.select().from(attachments).where(and(eq(attachments.tenantId, auth.tenantId), eq(attachments.id, id), isNull(attachments.deletedAt)));
    if (!a) throw notFound('Attachment');
    await this.parent(tx, auth, a.entityType, a.entityId, write);
    return a;
  }

  async download(auth: TenantAuthContext, id: string): Promise<{ data: Buffer; filename: string; mimeType: string }> {
    const a = await this.db.tenant(auth, (tx) => this.load(tx, auth, id, false));
    return { data: await this.storage.get(auth.tenantId, a.storageKey), filename: a.filename, mimeType: a.mimeType };
  }

  async remove(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    const a = await this.db.tenant(auth, async (tx) => {
      const a = await this.load(tx, auth, id, true);
      await tx.update(attachments).set({ deletedAt: new Date() }).where(and(eq(attachments.tenantId, auth.tenantId), eq(attachments.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'attachment.delete', entityType: a.entityType, entityId: a.entityId,
        before: { attachmentId: id, filename: a.filename, sizeBytes: a.sizeBytes }, meta,
      });
      return a;
    });
    await this.storage.remove(auth.tenantId, a.storageKey);
  }
}
