import { Injectable } from '@nestjs/common';
import {
  customFieldDefs, opportunities, outcomeReasons, pipelineStages, pipelines, tracks, type Tx,
} from '@rakan/db';
import type {
  CrmSettingsDto, CustomFieldInput, PipelineDto, PipelineInput, TrackInput,
} from '@rakan/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService, pgErrorCode } from '../common/db.service';
import { conflict, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class CrmSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Idempotent: guarantees default pipeline/stages/reasons exist (new tenants, or tenants created before CRM). */
  async ensureDefaults(tx: Tx, tenantId: string): Promise<void> {
    await tx.$client.query('SELECT seed_crm_defaults($1)', [tenantId]);
  }

  async load(tx: Tx, tenantId: string): Promise<CrmSettingsDto> {
    await this.ensureDefaults(tx, tenantId);
    const [t, p, s, r, f] = await Promise.all([
      tx.select().from(tracks).where(eq(tracks.tenantId, tenantId)).orderBy(asc(tracks.createdAt)),
      tx.select().from(pipelines).where(eq(pipelines.tenantId, tenantId)).orderBy(asc(pipelines.createdAt)),
      tx.select().from(pipelineStages).where(eq(pipelineStages.tenantId, tenantId)).orderBy(asc(pipelineStages.position)),
      tx.select().from(outcomeReasons).where(eq(outcomeReasons.tenantId, tenantId)).orderBy(asc(outcomeReasons.createdAt)),
      tx.select().from(customFieldDefs).where(eq(customFieldDefs.tenantId, tenantId)).orderBy(asc(customFieldDefs.createdAt)),
    ]);
    return {
      tracks: t.map((x) => ({ id: x.id, key: x.key, name: x.name, description: x.description })),
      pipelines: p.map((x) => ({
        id: x.id,
        name: x.name,
        trackId: x.trackId,
        isDefault: x.isDefault,
        stages: s
          .filter((st) => st.pipelineId === x.id)
          .map((st) => ({ id: st.id, key: st.key, name: st.name, position: st.position, category: st.category, winProbability: st.winProbability })),
      })),
      reasons: r.map((x) => ({ id: x.id, kind: x.kind, label: x.label, isActive: x.isActive })),
      customFields: f.map((x) => ({
        id: x.id, entity: x.entity, key: x.key, label: x.label, type: x.type, options: x.options, trackId: x.trackId,
      })),
    };
  }

  get(auth: TenantAuthContext): Promise<CrmSettingsDto> {
    return this.db.tenant(auth, (tx) => this.load(tx, auth.tenantId));
  }

  /** Pipeline used for a new opportunity on an account: its track's pipeline, else the default. */
  async pipelineFor(tx: Tx, tenantId: string, trackId: string | null): Promise<PipelineDto> {
    const settings = await this.load(tx, tenantId);
    return (
      (trackId && settings.pipelines.find((p) => p.trackId === trackId)) ||
      settings.pipelines.find((p) => p.isDefault) ||
      settings.pipelines[0]!
    );
  }

  /** Creating a track also creates its own pipeline (copy of the default stages). */
  createTrack(auth: TenantAuthContext, input: TrackInput, meta: RequestMeta) {
    return this.db
      .tenant(auth, async (tx) => {
        await this.ensureDefaults(tx, auth.tenantId);
        const [t] = await tx.insert(tracks).values({ tenantId: auth.tenantId, ...input }).returning();
        const [def] = await tx
          .select()
          .from(pipelines)
          .where(and(eq(pipelines.tenantId, auth.tenantId), eq(pipelines.isDefault, true)));
        const stages = await tx
          .select()
          .from(pipelineStages)
          .where(and(eq(pipelineStages.tenantId, auth.tenantId), eq(pipelineStages.pipelineId, def!.id)));
        const [p] = await tx
          .insert(pipelines)
          .values({ tenantId: auth.tenantId, trackId: t!.id, name: `${def!.name} — ${t!.name}` })
          .returning();
        await tx.insert(pipelineStages).values(
          stages.map((s) => ({
            tenantId: auth.tenantId, pipelineId: p!.id, key: s.key, name: s.name, position: s.position,
            category: s.category, winProbability: s.winProbability,
          })),
        );
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.track.create', entityType: 'track',
          entityId: t!.id, after: input, meta,
        });
        return this.load(tx, auth.tenantId);
      })
      .catch((e) => {
        if (pgErrorCode(e) === '23505') throw conflict('NAME_TAKEN', 'A track with this key already exists');
        throw e;
      });
  }

  updateTrack(auth: TenantAuthContext, id: string, input: TrackInput, meta: RequestMeta) {
    return this.db.tenant(auth, async (tx) => {
      const [before] = await tx.select().from(tracks).where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, id)));
      if (!before) throw notFound('Track');
      await tx
        .update(tracks)
        .set({ name: input.name, description: input.description ?? null })
        .where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.track.update', entityType: 'track', entityId: id,
        before: { name: before.name, description: before.description }, after: { name: input.name, description: input.description }, meta,
      });
      return this.load(tx, auth.tenantId);
    });
  }

  /**
   * Replaces a pipeline's stages. Existing stages (by id) are updated, new ones inserted; a stage can be
   * removed only if no opportunity is in it (no silent data loss).
   */
  updatePipeline(auth: TenantAuthContext, id: string, input: PipelineInput, meta: RequestMeta) {
    return this.db.tenant(auth, async (tx) => {
      const [p] = await tx.select().from(pipelines).where(and(eq(pipelines.tenantId, auth.tenantId), eq(pipelines.id, id)));
      if (!p) throw notFound('Pipeline');
      const current = await tx
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.tenantId, auth.tenantId), eq(pipelineStages.pipelineId, id)));
      const keepIds = new Set(input.stages.filter((s) => s.id).map((s) => s.id!));
      const unknown = [...keepIds].filter((sid) => !current.some((c) => c.id === sid));
      if (unknown.length) throw notFound('Stage');
      const removed = current.filter((c) => !keepIds.has(c.id));
      if (removed.length) {
        const used = await tx
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(and(eq(opportunities.tenantId, auth.tenantId), inArray(opportunities.stageId, removed.map((r) => r.id)), isNull(opportunities.deletedAt)))
          .limit(1);
        if (used.length) throw conflict('STAGE_IN_USE', 'Move opportunities out of a stage before removing it');
        await tx.delete(pipelineStages).where(and(eq(pipelineStages.tenantId, auth.tenantId), inArray(pipelineStages.id, removed.map((r) => r.id))));
      }
      // Two passes avoid transient unique (pipeline, key) collisions when keys are swapped.
      for (const s of input.stages.filter((x) => x.id)) {
        await tx.update(pipelineStages).set({ key: `__tmp_${s.id!.slice(0, 8)}` }).where(and(eq(pipelineStages.tenantId, auth.tenantId), eq(pipelineStages.id, s.id!)));
      }
      for (const [i, s] of input.stages.entries()) {
        const values = { key: s.key, name: s.name, category: s.category, position: i + 1, winProbability: s.winProbability ?? null };
        if (s.id) await tx.update(pipelineStages).set(values).where(and(eq(pipelineStages.tenantId, auth.tenantId), eq(pipelineStages.id, s.id)));
        else await tx.insert(pipelineStages).values({ tenantId: auth.tenantId, pipelineId: id, ...values });
      }
      await tx.update(pipelines).set({ name: input.name }).where(and(eq(pipelines.tenantId, auth.tenantId), eq(pipelines.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.pipeline.update', entityType: 'pipeline', entityId: id,
        before: { name: p.name, stages: current.sort((a, b) => a.position - b.position).map((c) => c.name) },
        after: { name: input.name, stages: input.stages.map((s) => s.name) }, meta,
      });
      return this.load(tx, auth.tenantId);
    });
  }

  createReason(auth: TenantAuthContext, input: { kind: 'win' | 'loss' | 'postpone' | 'disqualify'; label: string }, meta: RequestMeta) {
    return this.db
      .tenant(auth, async (tx) => {
        const [r] = await tx.insert(outcomeReasons).values({ tenantId: auth.tenantId, kind: input.kind, label: input.label }).returning();
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.reason.create', entityType: 'outcome_reason', entityId: r!.id, after: input, meta,
        });
        return this.load(tx, auth.tenantId);
      })
      .catch((e) => {
        if (pgErrorCode(e) === '23505') throw conflict('NAME_TAKEN', 'This reason already exists');
        throw e;
      });
  }

  updateReason(auth: TenantAuthContext, id: string, input: { label?: string; isActive?: boolean }, meta: RequestMeta) {
    return this.db.tenant(auth, async (tx) => {
      const [before] = await tx.select().from(outcomeReasons).where(and(eq(outcomeReasons.tenantId, auth.tenantId), eq(outcomeReasons.id, id)));
      if (!before) throw notFound('Reason');
      await tx
        .update(outcomeReasons)
        .set({ ...(input.label ? { label: input.label } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) })
        .where(and(eq(outcomeReasons.tenantId, auth.tenantId), eq(outcomeReasons.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.reason.update', entityType: 'outcome_reason', entityId: id,
        before: { label: before.label, isActive: before.isActive }, after: input, meta,
      });
      return this.load(tx, auth.tenantId);
    });
  }

  createCustomField(auth: TenantAuthContext, input: CustomFieldInput, meta: RequestMeta) {
    return this.db
      .tenant(auth, async (tx) => {
        const [f] = await tx
          .insert(customFieldDefs)
          .values({ tenantId: auth.tenantId, ...input, options: input.type === 'select' ? input.options ?? [] : null, trackId: input.trackId ?? null })
          .returning();
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.custom_field.create', entityType: 'custom_field', entityId: f!.id, after: input, meta,
        });
        return this.load(tx, auth.tenantId);
      })
      .catch((e) => {
        if (pgErrorCode(e) === '23505') throw conflict('NAME_TAKEN', 'A field with this key already exists');
        if (pgErrorCode(e) === '23503') throw notFound('Track');
        throw e;
      });
  }

  deleteCustomField(auth: TenantAuthContext, id: string, meta: RequestMeta) {
    return this.db.tenant(auth, async (tx) => {
      const [f] = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.tenantId, auth.tenantId), eq(customFieldDefs.id, id)));
      if (!f) throw notFound('Custom field');
      await tx.delete(customFieldDefs).where(and(eq(customFieldDefs.tenantId, auth.tenantId), eq(customFieldDefs.id, id)));
      // Values stay in the records' JSON (no data loss) but are no longer shown or editable.
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'crm.custom_field.delete', entityType: 'custom_field', entityId: id,
        before: { key: f.key, label: f.label, entity: f.entity }, meta,
      });
      return this.load(tx, auth.tenantId);
    });
  }
}
