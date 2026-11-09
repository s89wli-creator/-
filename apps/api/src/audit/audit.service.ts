import { Injectable } from '@nestjs/common';
import { auditLogs, type Tx } from '@rakan/db';
import type { RequestMeta } from '../common/auth-context';

export interface AuditEntry {
  tenantId: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'platform_admin';
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: RequestMeta;
}

const SECRET_KEYS = /password|token|secret|hash/i;

/** Removes secret-looking fields before persisting snapshots. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEYS.test(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

@Injectable()
export class AuditService {
  /** Writes inside the caller's transaction so the audit entry commits atomically with the change. */
  async record(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.insert(auditLogs).values({
      tenantId: e.tenantId,
      actorType: e.actorType ?? 'user',
      actorUserId: e.actorUserId ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      before: e.before === undefined ? null : redact(e.before),
      after: e.after === undefined ? null : redact(e.after),
      ip: e.meta?.ip ?? null,
      userAgent: e.meta?.userAgent ?? null,
      requestId: e.meta?.requestId ?? null,
    });
  }
}
