import { Injectable, Logger } from '@nestjs/common';
import { approvalRequests, users } from '@rakan/db';
import type { ApprovalDto } from '@rakan/shared';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, conflict, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';

/**
 * Risk levels (docs/02 §AI): READ and WRITE_INTERNAL run immediately; EXTERNAL (anything that leaves the
 * company: messages, emails) and IRREVERSIBLE always wait for a human approval. The stored payload is the
 * exact thing executed after approval; its hash is re-checked before execution.
 */
export type Risk = 'READ' | 'WRITE_INTERNAL' | 'EXTERNAL' | 'IRREVERSIBLE';

export interface Tool<P extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  actionType: string;
  risk: Risk;
  /** Executes the action. For EXTERNAL/IRREVERSIBLE tools this runs only after approval, as the approver. */
  execute(auth: TenantAuthContext, payload: P, meta: RequestMeta): Promise<Record<string, unknown>>;
  /** Called when an approval is rejected or expires (e.g. return a draft to editable state). */
  onRejected?(auth: TenantAuthContext, payload: P): Promise<void>;
}

export interface InvokeOptions {
  summary: string;
  reason?: string;
  sources?: unknown;
  confidence?: number;
  requestedByType: 'user' | 'agent';
  agentRunId?: string | null;
  entityType?: string;
  entityId?: string;
}

const APPROVAL_DAYS = 7;

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
export const payloadHash = (p: unknown) => createHash('sha256').update(canonicalJson(p)).digest('hex');

type Row = typeof approvalRequests.$inferSelect;

@Injectable()
export class ToolGatewayService {
  private readonly log = new Logger('ToolGateway');
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  register(tool: Tool<never>): void {
    this.tools.set(tool.name, tool as unknown as Tool);
  }

  private tool(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new AppError(500, 'UNKNOWN_TOOL', `Tool ${name} is not registered`);
    return t;
  }

  /** The only way agents and features perform actions. */
  async invoke(
    auth: TenantAuthContext,
    toolName: string,
    payload: Record<string, unknown>,
    opts: InvokeOptions,
    meta: RequestMeta,
  ): Promise<{ status: 'executed'; result: Record<string, unknown> } | { status: 'pending_approval'; approvalId: string }> {
    const tool = this.tool(toolName);
    if (tool.risk === 'READ' || tool.risk === 'WRITE_INTERNAL') {
      return { status: 'executed', result: await tool.execute(auth, payload, meta) };
    }
    const id = await this.db.tenant(auth, async (tx) => {
      const [r] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: auth.tenantId, actionType: tool.actionType, toolName: tool.name, risk: tool.risk as 'EXTERNAL' | 'IRREVERSIBLE', payload,
          payloadHash: payloadHash(payload), summary: opts.summary, reason: opts.reason ?? null, sources: opts.sources ?? null,
          confidence: opts.confidence ?? null, requestedByType: opts.requestedByType, requestedBy: auth.userId,
          agentRunId: opts.agentRunId ?? null, entityType: opts.entityType ?? null, entityId: opts.entityId ?? null,
          expiresAt: new Date(Date.now() + APPROVAL_DAYS * 86400_000),
        })
        .returning({ id: approvalRequests.id });
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'approval.request', entityType: 'approval', entityId: r!.id,
        after: { tool: tool.name, summary: opts.summary },
      });
      return r!.id;
    });
    return { status: 'pending_approval', approvalId: id };
  }

  // ---------------------------------------------------------------- approvals inbox

  private async dtos(auth: TenantAuthContext, where: SQL | undefined, limit = 100): Promise<ApprovalDto[]> {
    await this.expireOld(auth);
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.tenantId, auth.tenantId), where))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(limit);
      const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter(Boolean) as string[])];
      const names = new Map<string, string>();
      for (const id of ids) {
        const [u] = await tx.select({ n: users.fullName }).from(users).where(eq(users.id, id));
        if (u) names.set(id, u.n);
      }
      return rows.map((r) => this.dto(r, names));
    });
  }

  private dto(r: Row, names: Map<string, string>): ApprovalDto {
    return {
      id: r.id, actionType: r.actionType, toolName: r.toolName, risk: r.risk, payload: r.payload, summary: r.summary, reason: r.reason,
      sources: r.sources, confidence: r.confidence, requestedByType: r.requestedByType,
      requestedByName: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null, agentRunId: r.agentRunId,
      entityType: r.entityType, entityId: r.entityId, status: r.status,
      decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null, decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote, executedAt: r.executedAt?.toISOString() ?? null, executionResult: r.executionResult,
      expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString(),
    };
  }

  list(auth: TenantAuthContext, status?: string): Promise<ApprovalDto[]> {
    return this.dtos(auth, status ? eq(approvalRequests.status, status as Row['status']) : undefined);
  }

  async get(auth: TenantAuthContext, id: string): Promise<ApprovalDto> {
    const [d] = await this.dtos(auth, eq(approvalRequests.id, id), 1);
    if (!d) throw notFound('Approval');
    return d;
  }

  async pendingCount(auth: TenantAuthContext): Promise<number> {
    return (await this.list(auth, 'pending')).length;
  }

  /** Marks overdue pending requests as expired and lets their tools clean up. */
  private async expireOld(auth: TenantAuthContext): Promise<void> {
    const expired = await this.db.tenant(auth, (tx) =>
      tx
        .update(approvalRequests)
        .set({ status: 'expired' })
        .where(and(eq(approvalRequests.tenantId, auth.tenantId), eq(approvalRequests.status, 'pending'), lt(approvalRequests.expiresAt, new Date())))
        .returning(),
    );
    for (const r of expired) await this.tools.get(r.toolName)?.onRejected?.(auth, r.payload).catch(() => undefined);
  }

  async decide(auth: TenantAuthContext, id: string, decision: 'approve' | 'reject', note: string | undefined, meta: RequestMeta): Promise<ApprovalDto> {
    await this.expireOld(auth);
    const row = await this.db.tenant(auth, async (tx) => {
      const [r] = await tx
        .update(approvalRequests)
        .set({ status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: auth.userId, decidedAt: new Date(), decisionNote: note ?? null })
        .where(and(eq(approvalRequests.tenantId, auth.tenantId), eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending')))
        .returning();
      if (!r) {
        const [exists] = await tx.select({ s: approvalRequests.status }).from(approvalRequests).where(and(eq(approvalRequests.tenantId, auth.tenantId), eq(approvalRequests.id, id)));
        if (!exists) throw notFound('Approval');
        throw conflict('ALREADY_DECIDED', 'This request was already decided or has expired');
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: decision === 'approve' ? 'approval.approve' : 'approval.reject',
        entityType: 'approval', entityId: r.id, after: { tool: r.toolName, note: note ?? null }, meta,
      });
      return r;
    });

    const tool = this.tool(row.toolName);
    if (decision === 'reject') {
      await tool.onRejected?.(auth, row.payload);
      return this.get(auth, id);
    }

    let status: 'executed' | 'execution_failed' = 'executed';
    let result: Record<string, unknown>;
    try {
      // Tamper check: execute exactly what was approved.
      if (payloadHash(row.payload) !== row.payloadHash) throw new AppError(409, 'PAYLOAD_CHANGED', 'The request changed after it was created');
      result = await tool.execute(auth, row.payload, meta);
    } catch (e) {
      status = 'execution_failed';
      result = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'EXECUTION_FAILED', message: 'The action failed' };
      if (!(e instanceof AppError)) this.log.error({ err: e, approvalId: id }, 'approved action failed');
    }
    await this.db.tenant(auth, async (tx) => {
      await tx
        .update(approvalRequests)
        .set({ status, executedAt: status === 'executed' ? new Date() : null, executionResult: result })
        .where(and(eq(approvalRequests.tenantId, auth.tenantId), eq(approvalRequests.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: status === 'executed' ? 'approval.executed' : 'approval.execution_failed',
        entityType: 'approval', entityId: id, after: result, meta,
      });
    });
    return this.get(auth, id);
  }
}
