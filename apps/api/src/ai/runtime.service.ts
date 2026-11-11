import { Inject, Injectable, Logger } from '@nestjs/common';
import { agentRuns, agentSteps, aiSettings, aiUsage, type Tx } from '@rakan/db';
import { AGENTS, type AgentKey } from '@rakan/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError } from '../common/errors';
import { LLM_PROVIDER, WEB_SEARCH_USD, costUsd, type ChatRequest, type ChatResult, type LlmProvider, type LlmRequest } from './llm';
import { PlanService } from '../platform/plan.service';

export type StepKind = 'context' | 'model_call' | 'validation' | 'tool_call' | 'guard_block' | 'approval_wait' | 'error';

export interface RunContext {
  runId: string;
  auth: TenantAuthContext;
  /** Structured model call: checks the budget, records usage, fails closed on refusal/invalid output. */
  call<T>(req: Omit<LlmRequest<T>, 'agent'>): Promise<T>;
  /** Same as call(), with web search; returns the pages the search actually returned. */
  search<T>(req: Omit<LlmRequest<T>, 'agent'>): Promise<{ output: T; sources: { url: string; title: string }[] }>;
  /** One tool-using turn (metered and budgeted like call()). */
  chat(req: Omit<ChatRequest, 'agent'>): Promise<ChatResult>;
  step(kind: StepKind, name: string, detail?: Record<string, unknown>): Promise<void>;
}

export interface Settings {
  enabled: boolean;
  monthlyBudgetUsd: number;
  agents: Record<AgentKey, { enabled: boolean }>;
}

/** Start of the current month in Riyadh time (billing month shown to customers). */
const MONTH_START = sql`(date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`;

/**
 * Runs one agent invocation: preconditions (provider, enabled, budget) -> body -> run record.
 * Every run is persisted (agent_runs + agent_steps) whether it succeeds or fails.
 */
@Injectable()
export class AiRuntimeService {
  private readonly log = new Logger('AiRuntime');

  constructor(
    private readonly db: DbService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly plans: PlanService,
  ) {}

  get providerReady(): boolean {
    return this.provider.ready;
  }

  async settings(tx: Tx, tenantId: string): Promise<Settings> {
    const [s] = await tx.select().from(aiSettings).where(eq(aiSettings.tenantId, tenantId));
    const agents = Object.fromEntries(AGENTS.map((a) => [a, { enabled: s?.agents?.[a]?.enabled ?? true }])) as Settings['agents'];
    return { enabled: s?.enabled ?? true, monthlyBudgetUsd: s?.monthlyBudgetUsd ?? 20, agents };
  }

  async monthSpend(tx: Tx, tenantId: string): Promise<{ usd: number; runs: number }> {
    const [u] = await tx
      .select({ usd: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, tenantId), gte(aiUsage.occurredAt, MONTH_START)));
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(and(eq(agentRuns.tenantId, tenantId), gte(agentRuns.startedAt, MONTH_START)));
    return { usd: Number(u?.usd ?? 0), runs: r?.n ?? 0 };
  }

  /** The company's own monthly budget, capped by its plan. */
  async effectiveBudget(tenantId: string, own: number): Promise<number> {
    const cap = await this.plans.aiCap(tenantId);
    return cap === null ? own : Math.min(own, cap);
  }

  private async assertCanSpend(tx: Tx, tenantId: string, agent: AgentKey): Promise<void> {
    if (!this.provider.ready) throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
    const s = await this.settings(tx, tenantId);
    if (!s.enabled) throw new AppError(403, 'AI_DISABLED', 'AI features are turned off for this company');
    if (!s.agents[agent].enabled) throw new AppError(403, 'AI_AGENT_DISABLED', 'This assistant is turned off for this company');
    const { usd } = await this.monthSpend(tx, tenantId);
    if (usd >= (await this.effectiveBudget(tenantId, s.monthlyBudgetUsd))) throw new AppError(402, 'AI_BUDGET_EXCEEDED', 'The monthly AI budget has been reached');
  }

  async run<T>(
    auth: TenantAuthContext,
    agent: AgentKey,
    opts: { entityType?: string; entityId?: string; input?: Record<string, unknown> },
    body: (ctx: RunContext) => Promise<{ output: T; status?: 'succeeded' | 'awaiting_approval' }>,
  ): Promise<{ runId: string; output: T }> {
    const runId = await this.db.tenant(auth, async (tx) => {
      await this.assertCanSpend(tx, auth.tenantId, agent);
      const [r] = await tx
        .insert(agentRuns)
        .values({
          tenantId: auth.tenantId, agent, triggerType: 'user', triggeredBy: auth.userId,
          entityType: opts.entityType ?? null, entityId: opts.entityId ?? null, input: opts.input ?? {},
        })
        .returning({ id: agentRuns.id });
      return r!.id;
    });

    const totals = { model: null as string | null, inputTokens: 0, outputTokens: 0, cost: 0 };
    const step: RunContext['step'] = (kind, name, detail = {}) =>
      this.db.tenant(auth, async (tx) => {
        await tx.insert(agentSteps).values({ tenantId: auth.tenantId, runId, kind, name, detail });
      });

    /** Records usage + a model_call step; web searches are billed at the provider's per-search rate. */
    const meter = async (res: { model: string; inputTokens: number; outputTokens: number; stopReason: string | null }, searches: number, started: number) => {
      const cost = costUsd(res.model, res.inputTokens, res.outputTokens) + searches * WEB_SEARCH_USD;
      totals.model = res.model;
      totals.inputTokens += res.inputTokens;
      totals.outputTokens += res.outputTokens;
      totals.cost += cost;
      await this.db.tenant(auth, async (tx) => {
        await tx.insert(aiUsage).values({
          tenantId: auth.tenantId, agentRunId: runId, provider: this.provider.name, model: res.model,
          inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost,
        });
        await tx.insert(agentSteps).values({
          tenantId: auth.tenantId, runId, kind: 'model_call', name: res.model,
          detail: { ms: Date.now() - started, inputTokens: res.inputTokens, outputTokens: res.outputTokens, webSearches: searches, costUsd: cost, stopReason: res.stopReason },
        });
      });
    };
    const structured = async <R>(req: Omit<LlmRequest<R>, 'agent'>): Promise<{ output: R; sources: { url: string; title: string }[] }> => {
      await this.db.tenant(auth, (tx) => this.assertCanSpend(tx, auth.tenantId, agent));
      const started = Date.now();
      const res = await this.provider.complete<R>({ ...req, agent });
      await meter(res, res.webSearches ?? 0, started);
      if (res.refused) throw new AppError(422, 'AI_REFUSED', 'The assistant declined this request');
      if (res.output === null) throw new AppError(502, 'AI_INVALID_OUTPUT', 'The assistant returned an invalid answer');
      return { output: res.output, sources: res.sources ?? [] };
    };

    const ctx: RunContext = {
      runId,
      auth,
      step,
      call: async <R>(req: Omit<LlmRequest<R>, 'agent'>): Promise<R> => (await structured<R>(req)).output,
      search: <R>(req: Omit<LlmRequest<R>, 'agent'>) => structured<R>(req),
      chat: async (req: Omit<ChatRequest, 'agent'>): Promise<ChatResult> => {
        await this.db.tenant(auth, (tx) => this.assertCanSpend(tx, auth.tenantId, agent));
        const started = Date.now();
        const res = await this.provider.chat({ ...req, agent });
        await meter(res, 0, started);
        if (res.refused) throw new AppError(422, 'AI_REFUSED', 'The assistant declined this request');
        return res;
      },
    };

    const finish = (values: Partial<typeof agentRuns.$inferInsert>) =>
      this.db.tenant(auth, (tx) =>
        tx
          .update(agentRuns)
          .set({ ...values, model: totals.model, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: totals.cost, finishedAt: new Date() })
          .where(and(eq(agentRuns.tenantId, auth.tenantId), eq(agentRuns.id, runId))),
      );

    try {
      const { output, status } = await body(ctx);
      await finish({ status: status ?? 'succeeded', output: output as unknown });
      return { runId, output };
    } catch (e) {
      const err = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'AI_ERROR', message: 'The assistant failed' };
      if (!(e instanceof AppError)) this.log.error({ err: e, runId, agent }, 'agent run failed');
      await step('error', err.code, {}).catch(() => undefined);
      await finish({ status: 'failed', error: err });
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'AI_ERROR', 'The assistant failed, please try again');
    }
  }
}
