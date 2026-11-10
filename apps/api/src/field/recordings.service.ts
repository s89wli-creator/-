import { Injectable } from '@nestjs/common';
import { tenants, users, visitRecordings, type Tx } from '@rakan/db';
import { RECORDING_CHUNK_BYTES, RECORDING_MAX_BYTES, type RecordingDto } from '@rakan/shared';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, forbidden, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../crm/scope';
import { VisitsService } from '../crm/visits.service';
import { StorageService } from './storage.service';
import { PlanService } from '../platform/plan.service';

type Row = typeof visitRecordings.$inferSelect;
const DEFAULT_RETENTION_DAYS = 90;

/** Recognizes the common audio containers from their first bytes (uploads that are not audio are rejected). */
export function looksLikeAudio(b: Buffer): boolean {
  if (b.length < 12) return false;
  const hex = b.subarray(0, 4).toString('hex');
  return (
    hex === '1a45dfa3' || // WebM / Matroska
    b.subarray(0, 4).toString('latin1') === 'OggS' ||
    b.subarray(4, 8).toString('latin1') === 'ftyp' || // MP4 / M4A
    (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') ||
    b.subarray(0, 3).toString('latin1') === 'ID3' ||
    (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) // MPEG audio / ADTS
  );
}

/**
 * Voice notes for visits. Rules:
 * - the company must enable recording (Company settings), and the rep confirms the customer's consent per recording;
 * - audio is uploaded in 1 MB chunks (resumable on weak mobile networks), assembled and stored encrypted;
 * - recordings are deleted automatically after the company's retention period (default 90 days);
 * - access follows the visit's scope (reps: their own visits).
 */
@Injectable()
export class RecordingsService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly scopes: ScopeService,
    private readonly visits: VisitsService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
  ) {}

  private chunkKey = (r: Row, n: number) => `${r.tenantId}/recordings/${r.id}/chunk-${String(n).padStart(3, '0')}`;
  private fileKey = (r: Row) => `${r.tenantId}/recordings/${r.id}.audio`;

  private async dto(tx: Tx, r: Row): Promise<RecordingDto> {
    const [u] = r.uploadedBy ? await tx.select({ n: users.fullName }).from(users).where(eq(users.id, r.uploadedBy)) : [];
    return {
      id: r.id, visitId: r.visitId, mimeType: r.mimeType, status: r.status, totalChunks: r.totalChunks, receivedChunks: [...r.receivedChunks].sort((a, b) => a - b),
      sizeBytes: r.sizeBytes, durationSec: r.durationSec, transcript: r.transcript, transcriptStatus: r.transcriptStatus,
      uploadedByName: u?.n ?? null, deleteAfter: r.deleteAfter.toISOString(), createdAt: r.createdAt.toISOString(),
    };
  }

  /** Loads a recording through its visit, enforcing the visit's record scope. */
  private async load(tx: Tx, auth: TenantAuthContext, id: string, write: boolean): Promise<Row> {
    const [r] = await tx.select().from(visitRecordings).where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.id, id)));
    if (!r || r.status === 'deleted') throw notFound('Recording');
    await this.visits.load(tx, auth, await this.scopes.forRequest(tx, auth), r.visitId, write);
    return r;
  }

  /** Deletes recordings past their retention date (lazy purge; a scheduled worker can call this too). */
  async purgeExpired(auth: TenantAuthContext): Promise<number> {
    const expired = await this.db.tenant(auth, (tx) =>
      tx
        .update(visitRecordings)
        .set({ status: 'deleted', storageKey: null, transcript: null })
        .where(and(eq(visitRecordings.tenantId, auth.tenantId), ne(visitRecordings.status, 'deleted'), lt(visitRecordings.deleteAfter, new Date())))
        .returning(),
    );
    for (const r of expired) {
      await this.storage.remove(auth.tenantId, `${r.tenantId}/recordings/${r.id}`);
      await this.storage.remove(auth.tenantId, this.fileKey(r));
    }
    return expired.length;
  }

  async list(auth: TenantAuthContext, visitId: string): Promise<RecordingDto[]> {
    await this.purgeExpired(auth);
    return this.db.tenant(auth, async (tx) => {
      await this.visits.load(tx, auth, await this.scopes.forRequest(tx, auth), visitId);
      const rows = await tx
        .select()
        .from(visitRecordings)
        .where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.visitId, visitId), ne(visitRecordings.status, 'deleted')))
        .orderBy(desc(visitRecordings.createdAt));
      return Promise.all(rows.map((r) => this.dto(tx, r)));
    });
  }

  async start(auth: TenantAuthContext, visitId: string, input: { mimeType: string; totalChunks: number; durationSec?: number }, meta: RequestMeta): Promise<RecordingDto> {
    return this.db.tenant(auth, async (tx) => {
      const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, auth.tenantId));
      const settings = (t?.settings ?? {}) as { recordingEnabled?: boolean; recordingRetentionDays?: number };
      if (!settings.recordingEnabled) throw forbidden('Recording is turned off for this company');
      await this.plans.assertStorage(auth.tenantId, 0);
      const v = await this.visits.load(tx, auth, await this.scopes.forRequest(tx, auth), visitId, true);
      if (v.status === 'cancelled') throw new AppError(409, 'INVALID_STATE', 'The visit was cancelled');
      const days = settings.recordingRetentionDays ?? DEFAULT_RETENTION_DAYS;
      const [r] = await tx
        .insert(visitRecordings)
        .values({
          tenantId: auth.tenantId, visitId, uploadedBy: auth.userId, consentConfirmed: true, mimeType: input.mimeType,
          totalChunks: input.totalChunks, durationSec: input.durationSec ?? null, deleteAfter: new Date(Date.now() + days * 86400_000),
        })
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'recording.start', entityType: 'visit', entityId: visitId,
        after: { recordingId: r!.id, consentConfirmed: true, retentionDays: days }, meta,
      });
      return this.dto(tx, r!);
    });
  }

  async putChunk(auth: TenantAuthContext, id: string, n: number, data: Buffer): Promise<{ received: number[] }> {
    if (!Buffer.isBuffer(data) || data.length === 0) throw badRequest('EMPTY_FILE', 'Empty chunk');
    if (data.length > RECORDING_CHUNK_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Chunk too large');
    const r = await this.db.tenant(auth, (tx) => this.load(tx, auth, id, true));
    if (r.status !== 'uploading') throw new AppError(409, 'INVALID_STATE', 'Upload already completed');
    if (n < 0 || n >= r.totalChunks) throw badRequest('INVALID_CHUNK', 'Chunk number out of range');
    if (n === 0 && !looksLikeAudio(data)) throw badRequest('UNSUPPORTED_FILE', 'Not an audio file');
    await this.storage.put(auth.tenantId, this.chunkKey(r, n), data);
    // Re-sending a chunk (retry) is harmless: the set of received chunk numbers is updated under a row lock.
    const received = await this.db.tenant(auth, async (tx) => {
      const [cur] = await tx.select({ rc: visitRecordings.receivedChunks }).from(visitRecordings).where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.id, id))).for('update');
      const next = [...new Set([...(cur?.rc ?? []), n])].sort((a, b) => a - b);
      await tx.update(visitRecordings).set({ receivedChunks: next }).where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.id, id)));
      return next;
    });
    return { received };
  }

  async complete(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<RecordingDto> {
    const r = await this.db.tenant(auth, (tx) => this.load(tx, auth, id, true));
    if (r.status === 'ready') return this.db.tenant(auth, (tx) => this.dto(tx, r));
    const missing = Array.from({ length: r.totalChunks }, (_, i) => i).filter((i) => !r.receivedChunks.includes(i));
    if (missing.length) throw new AppError(409, 'CHUNKS_MISSING', 'Some parts were not uploaded yet', { missing });
    const parts: Buffer[] = [];
    let size = 0;
    for (let i = 0; i < r.totalChunks; i++) {
      const b = await this.storage.get(auth.tenantId, this.chunkKey(r, i));
      size += b.length;
      if (size > RECORDING_MAX_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Recording too large');
      parts.push(b);
    }
    const audio = Buffer.concat(parts);
    await this.plans.assertStorage(auth.tenantId, audio.length);
    await this.storage.put(auth.tenantId, this.fileKey(r), audio);
    await this.storage.remove(auth.tenantId, `${r.tenantId}/recordings/${r.id}`);
    return this.db.tenant(auth, async (tx) => {
      const [u] = await tx
        .update(visitRecordings)
        .set({ status: 'ready', sizeBytes: audio.length, storageKey: this.fileKey(r) })
        .where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.id, id)))
        .returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'recording.upload', entityType: 'visit', entityId: r.visitId, after: { recordingId: id, bytes: audio.length }, meta });
      return this.dto(tx, u!);
    });
  }

  async audio(auth: TenantAuthContext, id: string): Promise<{ data: Buffer; mimeType: string }> {
    const r = await this.db.tenant(auth, (tx) => this.load(tx, auth, id, false));
    if (r.status !== 'ready' || !r.storageKey) throw notFound('Recording');
    return { data: await this.storage.get(auth.tenantId, r.storageKey), mimeType: r.mimeType };
  }

  /** Manual transcript or correction of an automatic one. */
  async setTranscript(auth: TenantAuthContext, id: string, transcript: string, meta: RequestMeta): Promise<RecordingDto> {
    return this.db.tenant(auth, async (tx) => {
      const r = await this.load(tx, auth, id, true);
      const [u] = await tx
        .update(visitRecordings)
        .set({ transcript, transcriptStatus: 'manual' })
        .where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.id, id)))
        .returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'recording.transcript', entityType: 'visit', entityId: r.visitId, after: { recordingId: id, chars: transcript.length }, meta });
      return this.dto(tx, u!);
    });
  }

  async remove(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    const r = await this.db.tenant(auth, async (tx) => {
      const r = await this.load(tx, auth, id, true);
      await tx.update(visitRecordings).set({ status: 'deleted', storageKey: null, transcript: null }).where(and(eq(visitRecordings.tenantId, auth.tenantId), eq(visitRecordings.id, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'recording.delete', entityType: 'visit', entityId: r.visitId, after: { recordingId: id }, meta });
      return r;
    });
    await this.storage.remove(auth.tenantId, `${r.tenantId}/recordings/${r.id}`);
    await this.storage.remove(auth.tenantId, this.fileKey(r));
  }
}
