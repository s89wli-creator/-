import { Controller, Get, Query } from '@nestjs/common';
import { auditLogs, users } from '@rakan/db';
import { auditQuerySchema, type AuditLogDto, type AuditQuery } from '@rakan/shared';
import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { Auth, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @RequirePermission('audit.read')
  @Get()
  list(
    @Auth() auth: TenantAuthContext,
    @Query(new ZodPipe(auditQuerySchema)) q: AuditQuery,
  ): Promise<{ items: AuditLogDto[]; nextCursor: number | null }> {
    return this.db.tenant(auth, async (tx) => {
      // RLS already restricts rows to the tenant; the explicit filter documents intent.
      const where: SQL[] = [eq(auditLogs.tenantId, auth.tenantId)];
      if (q.action) where.push(eq(auditLogs.action, q.action));
      if (q.entityType) where.push(eq(auditLogs.entityType, q.entityType));
      if (q.actorUserId) where.push(eq(auditLogs.actorUserId, q.actorUserId));
      if (q.from) where.push(gte(auditLogs.createdAt, q.from));
      if (q.to) where.push(lte(auditLogs.createdAt, q.to));
      if (q.before) where.push(lt(auditLogs.id, q.before));
      const rows = await tx
        .select({ log: auditLogs, actorName: users.fullName })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(and(...where))
        .orderBy(desc(auditLogs.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map(({ log, actorName }) => ({
          id: log.id,
          actorType: log.actorType,
          actorUserId: log.actorUserId,
          actorName: actorName ?? null,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId,
          before: log.before,
          after: log.after,
          ip: log.ip,
          createdAt: log.createdAt.toISOString(),
        })),
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.log.id : null,
      };
    });
  }
}
