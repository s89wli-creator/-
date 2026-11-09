import { Injectable } from '@nestjs/common';
import { territories, territoryAssignments, type Tx } from '@rakan/db';
import type { TerritoryDto, TerritoryInput } from '@rakan/shared';
import { asc, eq, and } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService, pgErrorCode } from '../common/db.service';
import { badRequest, conflict, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class TerritoryService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async dto(tx: Tx, tenantId: string, id: string): Promise<TerritoryDto> {
    const [t] = await tx
      .select()
      .from(territories)
      .where(and(eq(territories.tenantId, tenantId), eq(territories.id, id)))
      .limit(1);
    if (!t) throw notFound('Territory');
    const members = await tx
      .select({ id: territoryAssignments.membershipId })
      .from(territoryAssignments)
      .where(and(eq(territoryAssignments.tenantId, tenantId), eq(territoryAssignments.territoryId, id)));
    return { id: t.id, name: t.name, regions: t.regions, cities: t.cities, memberIds: members.map((m) => m.id) };
  }

  list(auth: TenantAuthContext): Promise<TerritoryDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx.select().from(territories).where(eq(territories.tenantId, auth.tenantId)).orderBy(asc(territories.name));
      const assignments = await tx.select().from(territoryAssignments).where(eq(territoryAssignments.tenantId, auth.tenantId));
      return rows.map((t) => ({
        id: t.id,
        name: t.name,
        regions: t.regions,
        cities: t.cities,
        memberIds: assignments.filter((a) => a.territoryId === t.id).map((a) => a.membershipId),
      }));
    });
  }

  private mapErrors(e: unknown): never {
    if (pgErrorCode(e) === '23505') throw conflict('NAME_TAKEN', 'A territory with this name already exists');
    if (pgErrorCode(e) === '23503') throw badRequest('INVALID_MEMBER', 'One or more members do not exist');
    throw e;
  }

  async create(auth: TenantAuthContext, input: TerritoryInput, meta: RequestMeta): Promise<TerritoryDto> {
    return this.db
      .tenant(auth, async (tx) => {
        const [t] = await tx.insert(territories).values({ tenantId: auth.tenantId, ...input }).returning();
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'territory.create',
          entityType: 'territory', entityId: t!.id, after: input, meta,
        });
        return this.dto(tx, auth.tenantId, t!.id);
      })
      .catch((e) => this.mapErrors(e));
  }

  async update(auth: TenantAuthContext, id: string, input: TerritoryInput, meta: RequestMeta): Promise<TerritoryDto> {
    return this.db
      .tenant(auth, async (tx) => {
        const { name, regions, cities } = await this.dto(tx, auth.tenantId, id);
        const before = { name, regions, cities };
        const after = { name: input.name, regions: input.regions, cities: input.cities };
        if (JSON.stringify(before) === JSON.stringify(after)) return this.dto(tx, auth.tenantId, id); // no-op
        await tx.update(territories).set({ ...input, updatedAt: new Date() }).where(and(eq(territories.tenantId, auth.tenantId), eq(territories.id, id)));
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'territory.update',
          entityType: 'territory', entityId: id, before, after: input, meta,
        });
        return this.dto(tx, auth.tenantId, id);
      })
      .catch((e) => this.mapErrors(e));
  }

  async remove(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth, async (tx) => {
      const before = await this.dto(tx, auth.tenantId, id);
      await tx.delete(territories).where(and(eq(territories.tenantId, auth.tenantId), eq(territories.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'territory.delete',
        entityType: 'territory', entityId: id, before, meta,
      });
    });
  }

  async setMembers(auth: TenantAuthContext, id: string, membershipIds: string[], meta: RequestMeta): Promise<TerritoryDto> {
    return this.db
      .tenant(auth, async (tx) => {
        const before = await this.dto(tx, auth.tenantId, id);
        const unique = [...new Set(membershipIds)];
        const same = unique.length === before.memberIds.length && unique.every((m) => before.memberIds.includes(m));
        if (same) return before; // no-op: no write, no audit noise
        await tx
          .delete(territoryAssignments)
          .where(and(eq(territoryAssignments.tenantId, auth.tenantId), eq(territoryAssignments.territoryId, id)));
        if (unique.length) {
          // Composite FK (tenant_id, membership_id) rejects members of other tenants.
          await tx
            .insert(territoryAssignments)
            .values(unique.map((membershipId) => ({ tenantId: auth.tenantId, territoryId: id, membershipId })));
        }
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'territory.assign',
          entityType: 'territory', entityId: id, before: { memberIds: before.memberIds }, after: { memberIds: unique }, meta,
        });
        return this.dto(tx, auth.tenantId, id);
      })
      .catch((e) => this.mapErrors(e));
  }
}
