import { Injectable } from '@nestjs/common';
import { agentRuns, agentSteps, aiSettings, scoringModels, users, type Tx } from '@rakan/db';
import {
  AGENTS, SCORING_CRITERIA, type AgentRunDto, type AgentStepDto, type AiSettingsDto, type AiUsageDto, type ScoringCriterion,
} from '@rakan/shared';
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { badRequest, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AiRuntimeService } from './runtime.service';

export const DEFAULT_WEIGHTS: Record<ScoringCriterion, number> = {
  icp_fit: 30, need_size: 20, region_fit: 15, buying_power: 15, recurring_need: 10, data_quality: 10,
};
export const DEFAULT_TIERS = { A: 75, B: 55, C: 35 };

export interface ScoringModel {
  weights: Record<ScoringCriterion, number>;
  tierThresholds: { A: number; B: number; C: number };
  version: number;
}

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly runtime: AiRuntimeService,
  ) {}

  async scoring(tx: Tx, tenantId: string): Promise<ScoringModel> {
    const [m] = await tx.select().from(scoringModels).where(eq(scoringModels.tenantId, tenantId));
    if (!m) return { weights: { ...DEFAULT_WEIGHTS }, tierThresholds: { ...DEFAULT_TIERS }, version: 0 };
    const weights = Object.fromEntries(SCORING_CRITERIA.map((k) => [k, m.weights[k] ?? 0])) as Record<ScoringCriterion, number>;
    return { weights, tierThresholds: m.tierThresholds, version: m.version };
  }

  async usage(auth: TenantAuthContext): Promise<AiUsageDto> {
    return this.db.tenant(auth, async (tx) => {
      const s = await this.runtime.settings(tx, auth.tenantId);
      const spend = await this.runtime.monthSpend(tx, auth.tenantId);
      return {
        monthUsd: Math.round(spend.usd * 10000) / 10000, budgetUsd: await this.runtime.effectiveBudget(auth.tenantId, s.monthlyBudgetUsd), runsThisMonth: spend.runs,
        enabled: s.enabled, providerReady: this.runtime.providerReady,
      };
    });
  }

  /** What any AI user needs to know to show/hide assistant buttons. */
  async status(auth: TenantAuthContext) {
    const u = await this.usage(auth);
    const s = await this.db.tenant(auth, (tx) => this.runtime.settings(tx, auth.tenantId));
    return {
      available: u.enabled && u.providerReady && u.monthUsd < u.budgetUsd,
      providerReady: u.providerReady, enabled: u.enabled, budgetReached: u.monthUsd >= u.budgetUsd, agents: s.agents,
    };
  }

  async get(auth: TenantAuthContext): Promise<AiSettingsDto> {
    const usage = await this.usage(auth);
    return this.db.tenant(auth, async (tx) => {
      const s = await this.runtime.settings(tx, auth.tenantId);
      return { enabled: s.enabled, voiceEnabled: s.voiceEnabled, monthlyBudgetUsd: s.monthlyBudgetUsd, agents: s.agents, usage, scoring: await this.scoring(tx, auth.tenantId) };
    });
  }

  async update(
    auth: TenantAuthContext,
    input: { enabled?: boolean; monthlyBudgetUsd?: number; agents?: Partial<Record<string, { enabled: boolean }>>; voiceEnabled?: boolean },
    meta: RequestMeta,
  ): Promise<AiSettingsDto> {
    await this.db.tenant(auth, async (tx) => {
      const before = await this.runtime.settings(tx, auth.tenantId);
      const agents = { ...before.agents, ...(input.agents ?? {}) };
      const next = {
        enabled: input.enabled ?? before.enabled, monthlyBudgetUsd: input.monthlyBudgetUsd ?? before.monthlyBudgetUsd, agents,
        voiceEnabled: input.voiceEnabled ?? before.voiceEnabled,
      };
      await tx
        .insert(aiSettings)
        .values({ tenantId: auth.tenantId, ...next, updatedAt: new Date() })
        .onConflictDoUpdate({ target: aiSettings.tenantId, set: { ...next, updatedAt: new Date() } });
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'ai.settings.update', entityType: 'ai_settings', before, after: next, meta });
    });
    return this.get(auth);
  }

  async updateScoring(
    auth: TenantAuthContext,
    input: { weights: Partial<Record<ScoringCriterion, number>>; tierThresholds?: { A: number; B: number; C: number } },
    meta: RequestMeta,
  ): Promise<AiSettingsDto> {
    const weights = Object.fromEntries(SCORING_CRITERIA.map((k) => [k, input.weights[k] ?? 0])) as Record<ScoringCriterion, number>;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (total !== 100) throw badRequest('WEIGHTS_NOT_100', 'Weights must add up to 100', { total });
    const tiers = input.tierThresholds ?? DEFAULT_TIERS;
    if (!(tiers.A > tiers.B && tiers.B > tiers.C)) throw badRequest('INVALID_THRESHOLDS', 'Thresholds must be A > B > C');
    await this.db.tenant(auth, async (tx) => {
      const before = await this.scoring(tx, auth.tenantId);
      const version = before.version + 1;
      await tx
        .insert(scoringModels)
        .values({ tenantId: auth.tenantId, weights, tierThresholds: tiers, version, updatedBy: auth.userId })
        .onConflictDoUpdate({ target: scoringModels.tenantId, set: { weights, tierThresholds: tiers, version, updatedBy: auth.userId, updatedAt: new Date() } });
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'ai.scoring.update', entityType: 'scoring_model',
        before: { weights: before.weights, tierThresholds: before.tierThresholds }, after: { weights, tierThresholds: tiers, version }, meta,
      });
    });
    return this.get(auth);
  }

  // ---------------------------------------------------------------- run log

  private runDto(r: typeof agentRuns.$inferSelect, name: string | null): AgentRunDto {
    return {
      id: r.id, agent: r.agent, status: r.status, triggeredByName: name, entityType: r.entityType, entityId: r.entityId, model: r.model,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, error: r.error ?? null,
      startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }

  async runs(auth: TenantAuthContext, filter: { agent?: string; entityId?: string }): Promise<AgentRunDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const conds: SQL[] = [eq(agentRuns.tenantId, auth.tenantId)];
      if (filter.agent && (AGENTS as readonly string[]).includes(filter.agent)) conds.push(eq(agentRuns.agent, filter.agent));
      if (filter.entityId) conds.push(eq(agentRuns.entityId, filter.entityId));
      const rows = await tx
        .select({ r: agentRuns, name: users.fullName })
        .from(agentRuns)
        .leftJoin(users, eq(users.id, agentRuns.triggeredBy))
        .where(and(...conds))
        .orderBy(desc(agentRuns.startedAt))
        .limit(200);
      return rows.map(({ r, name }) => this.runDto(r, name));
    });
  }

  async run(auth: TenantAuthContext, id: string): Promise<AgentRunDto & { steps: AgentStepDto[]; output: unknown }> {
    return this.db.tenant(auth, async (tx) => {
      const [row] = await tx
        .select({ r: agentRuns, name: users.fullName })
        .from(agentRuns)
        .leftJoin(users, eq(users.id, agentRuns.triggeredBy))
        .where(and(eq(agentRuns.tenantId, auth.tenantId), eq(agentRuns.id, id)));
      if (!row) throw notFound('Run');
      const steps = await tx
        .select()
        .from(agentSteps)
        .where(and(eq(agentSteps.tenantId, auth.tenantId), eq(agentSteps.runId, id)))
        .orderBy(asc(agentSteps.id));
      return {
        ...this.runDto(row.r, row.name),
        output: row.r.output,
        steps: steps.map((s) => ({ id: s.id, kind: s.kind, name: s.name, detail: s.detail, createdAt: s.createdAt.toISOString() })),
      };
    });
  }
}
