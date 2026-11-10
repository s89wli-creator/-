import { Injectable } from '@nestjs/common';
import { accounts, leadScores, meetingInsights, visitBriefs, visitRecordings, type Tx } from '@rakan/db';
import {
  SCORING_CRITERIA, normalizeArabic,
  type Evidence, type LeadScoreDto, type MeetingInsightsDto, type ScoringCriterion, type VisitBriefDto,
} from '@rakan/shared';
import { and, desc, eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from '../crm/accounts.service';
import { ActivityService } from '../crm/activity.service';
import { ScopeService } from '../crm/scope';
import { VisitsService } from '../crm/visits.service';
import { AiSettingsService } from './ai-settings.service';
import { BrainService } from './brain.service';
import { accountGrounding, brainGrounding, merge, toEvidence } from './context';
import { BASE_RULES, findForbidden, redactPii, untrusted } from './guards';
import { AiRuntimeService } from './runtime.service';

// ---------------------------------------------------------------- output schemas (sent to the model)

const AI_CRITERIA = SCORING_CRITERIA.filter((c) => c !== 'data_quality') as Exclude<ScoringCriterion, 'data_quality'>[];

const leadIntelSchema = z.object({
  criteria: z.array(
    z.object({
      key: z.enum(AI_CRITERIA as [string, ...string[]]),
      score: z.number().int().min(0).max(100),
      reason: z.string(),
      evidence: z.array(z.string()).describe('References in [brackets] from the input that support this score'),
    }),
  ),
  disqualify: z.object({ matched: z.boolean(), reason: z.string(), evidence: z.array(z.string()) }),
  summary: z.string(),
  missingData: z.array(z.string()).describe('Information that would change the assessment if known'),
});

const visitBriefSchema = z.object({
  summary: z.string(),
  whyTarget: z.array(z.object({ text: z.string(), evidence: z.array(z.string()) })),
  goals: z.array(z.string()),
  questions: z.array(z.string()),
  valuePoints: z.array(z.object({ text: z.string(), source: z.string().describe('One brain:/doc: reference') })),
  objections: z.array(z.object({ objection: z.string(), response: z.string(), source: z.string() })),
  cautions: z.array(z.string()),
});

const meetingSchema = z.object({
  summary: z.string(),
  statedFacts: z.array(
    z.object({
      type: z.enum(['need', 'volume', 'budget', 'timeline', 'decision_maker', 'competitor', 'objection', 'other']),
      value: z.string(),
      quote: z.string().describe('Exact words copied from the notes'),
    }),
  ),
  inferences: z.array(z.object({ type: z.string(), value: z.string(), reasoning: z.string(), confidence: z.number().min(0).max(1) })),
  nextActions: z.array(z.object({ action: z.string(), dueInDays: z.number().int().min(0).max(90).nullable() })),
  interestLevel: z.number().int().min(1).max(5).nullable(),
  progressLikelihood: z.number().min(0).max(1).nullable(),
});

const CRITERION_AR: Record<ScoringCriterion, string> = {
  icp_fit: 'مطابقة العميل المثالي', need_size: 'حجم الاحتياج المتوقع', region_fit: 'المنطقة الجغرافية',
  buying_power: 'القدرة الشرائية', recurring_need: 'تكرار الاحتياج', data_quality: 'جودة البيانات',
};

type Removed = { text: string; reason: string };

@Injectable()
export class AgentsService {
  constructor(
    private readonly db: DbService,
    private readonly runtime: AiRuntimeService,
    private readonly brain: BrainService,
    private readonly settings: AiSettingsService,
    private readonly scopes: ScopeService,
    private readonly accountsSvc: AccountsService,
    private readonly visitsSvc: VisitsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  // ================================================================ Lead Intelligence

  /** Data completeness, computed in code (never by the model). */
  static dataQuality(a: typeof accounts.$inferSelect, contactCount: number): { score: number; missing: string[] } {
    const checks: [boolean, string][] = [
      [!!a.industry, 'القطاع'], [!!a.sizeBand, 'حجم الشركة'], [!!(a.city || a.region), 'المدينة أو المنطقة'],
      [!!a.crNumber, 'السجل التجاري'], [!!a.websiteDomain, 'الموقع الإلكتروني'], [contactCount > 0, 'جهة اتصال'],
    ];
    const ok = checks.filter(([v]) => v).length;
    return { score: Math.round((ok / checks.length) * 100), missing: checks.filter(([v]) => !v).map(([, l]) => l) };
  }

  async scoreAccount(auth: TenantAuthContext, accountId: string, meta: RequestMeta): Promise<LeadScoreDto> {
    const prep = await this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const a = await this.accountsSvc.loadAccount(tx, auth, scope, accountId);
      const g = await accountGrounding(tx, auth.tenantId, a);
      const entries = await this.brain.retrieve(tx, auth.tenantId, `${a.industry ?? ''} ${a.city ?? ''} ${a.region ?? ''} ${a.sizeBand ?? ''}`, {
        sections: ['icp', 'non_fit', 'target_segments', 'target_regions', 'products', 'company_profile'],
      });
      const model = await this.settings.scoring(tx, auth.tenantId);
      const contactsCount = g.refs.has('account:contacts') ? 1 : 0;
      return { a, grounding: merge(g, brainGrounding(entries)), model, dq: AgentsService.dataQuality(a, contactsCount) };
    });

    const { runId, output } = await this.runtime.run(auth, 'lead_intel', { entityType: 'account', entityId: accountId }, async (ctx) => {
      await ctx.step('context', 'grounding', { refs: [...prep.grounding.refs.keys()] });
      const out = await ctx.call({
        system: `${BASE_RULES}
مهمتك: تقييم مدى ملاءمة عميل محتمل لهذه الشركة وفق معايير محددة. لا تحسب الدرجة النهائية؛ النظام يحسبها.
لكل معيار: درجة 0-100، وسبب مختصر، وقائمة مراجع من المدخلات بين [أقواس] تدعم الدرجة. المعيار بلا مراجع يُعتبر غير مدعوم.
قيّم هذه المعايير فقط: ${AI_CRITERIA.map((c) => `${c} (${CRITERION_AR[c]})`).join('، ')}.
إذا طابق العميل وصفاً في قسم non_fit المعتمد فاجعل disqualify.matched=true مع مرجع ذلك البند.`,
        prompt: prep.grounding.text,
        effort: 'medium',
        schema: leadIntelSchema,
      });

      // ---- validation & scoring in code
      const weights = prep.model.weights;
      const removed: Removed[] = [];
      const criteria: LeadScoreDto['criteria'] = [];
      const missing = new Set<string>([...prep.dq.missing, ...out.missingData.slice(0, 10)]);
      let supportedWeight = weights.data_quality;
      for (const key of AI_CRITERIA) {
        const c = out.criteria.find((x) => x.key === key);
        const evidence = c ? toEvidence(prep.grounding.refs, c.evidence) : [];
        if (!c || !evidence.length) {
          if (c) removed.push({ text: `${CRITERION_AR[key]}: ${c.reason}`, reason: 'no_source' });
          missing.add(CRITERION_AR[key]);
          criteria.push({ key, score: 0, weight: weights[key], reason: 'لا توجد بيانات كافية لتقييم هذا المعيار', evidence: [], method: 'ai' });
          continue;
        }
        supportedWeight += weights[key];
        criteria.push({ key, score: c.score, weight: weights[key], reason: c.reason, evidence, method: 'ai' });
      }
      criteria.push({
        key: 'data_quality', score: prep.dq.score, weight: weights.data_quality,
        reason: prep.dq.missing.length ? `ينقص: ${prep.dq.missing.join('، ')}` : 'البيانات الأساسية مكتملة', evidence: [], method: 'rule',
      });
      const score = Math.round(criteria.reduce((s, c) => s + (c.score * c.weight) / 100, 0));
      const disqEvidence = out.disqualify.matched ? toEvidence(prep.grounding.refs, out.disqualify.evidence).filter((e) => e.ref.startsWith('brain:')) : [];
      const disqualified = disqEvidence.length > 0;
      const t = prep.model.tierThresholds;
      const tier = disqualified ? 'D' : score >= t.A ? 'A' : score >= t.B ? 'B' : score >= t.C ? 'C' : 'D';
      const confidence = Math.round((supportedWeight / 100) * (0.5 + prep.dq.score / 200) * 1000) / 1000;
      await ctx.step('validation', 'lead_score', { score, tier, removed: removed.length, confidence });

      const row = await this.db.tenant(auth, async (tx) => {
        const [r] = await tx
          .insert(leadScores)
          .values({
            tenantId: auth.tenantId, accountId, score, tier, disqualified, criteria, missingData: [...missing], confidence,
            summary: disqualified ? `${out.summary}\nسبب الاستبعاد: ${out.disqualify.reason}` : out.summary,
            modelVersion: prep.model.version, agentRunId: ctx.runId,
          })
          .returning();
        await tx.update(accounts).set({ score, scoreTier: tier }).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, accountId)));
        await this.activity.record(tx, { tenantId: auth.tenantId, accountId, type: 'ai_score', actorType: 'agent', actorUserId: auth.userId, refType: 'lead_score', refId: r!.id, summary: `تقييم ${tier} (${score}/100)` });
        return r!;
      });
      return { output: this.scoreDto(row) };
    });
    void runId;
    void meta;
    return output;
  }

  private scoreDto(r: typeof leadScores.$inferSelect): LeadScoreDto {
    return {
      id: r.id, accountId: r.accountId, score: r.score, tier: r.tier, disqualified: r.disqualified, criteria: r.criteria as LeadScoreDto['criteria'],
      missingData: r.missingData, confidence: r.confidence, summary: r.summary, reviewStatus: r.reviewStatus, overrideTier: r.overrideTier,
      overrideNote: r.overrideNote, agentRunId: r.agentRunId, createdAt: r.createdAt.toISOString(),
    };
  }

  async scores(auth: TenantAuthContext, accountId: string): Promise<LeadScoreDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.accountsSvc.loadAccount(tx, auth, scope, accountId);
      const rows = await tx
        .select()
        .from(leadScores)
        .where(and(eq(leadScores.tenantId, auth.tenantId), eq(leadScores.accountId, accountId)))
        .orderBy(desc(leadScores.createdAt))
        .limit(10);
      return rows.map((r) => this.scoreDto(r));
    });
  }

  /** Human review: accept the AI tier or override it (the override becomes the account tier). */
  async reviewScore(auth: TenantAuthContext, id: string, input: { decision: 'accept' | 'override'; tier?: 'A' | 'B' | 'C' | 'D'; note?: string }, meta: RequestMeta): Promise<LeadScoreDto> {
    if (input.decision === 'override' && !input.tier) throw badRequest('VALIDATION_ERROR', 'Tier is required', [{ path: 'tier', message: 'required' }]);
    return this.db.tenant(auth, async (tx) => {
      const [cur] = await tx.select().from(leadScores).where(and(eq(leadScores.tenantId, auth.tenantId), eq(leadScores.id, id)));
      if (!cur) throw notFound('Score');
      const scope = await this.scopes.forRequest(tx, auth);
      await this.accountsSvc.loadAccount(tx, auth, scope, cur.accountId, true);
      const override = input.decision === 'override';
      const [r] = await tx
        .update(leadScores)
        .set({ reviewStatus: override ? 'overridden' : 'accepted', overrideTier: override ? input.tier! : null, overrideNote: input.note ?? null, reviewedBy: auth.userId })
        .where(and(eq(leadScores.tenantId, auth.tenantId), eq(leadScores.id, id)))
        .returning();
      if (override) await tx.update(accounts).set({ scoreTier: input.tier! }).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, cur.accountId)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'ai.score.review', entityType: 'lead_score', entityId: id,
        before: { tier: cur.tier }, after: { decision: input.decision, tier: input.tier ?? cur.tier, note: input.note ?? null }, meta,
      });
      return this.scoreDto(r!);
    });
  }

  // ================================================================ Visit brief

  async visitBrief(auth: TenantAuthContext, visitId: string): Promise<VisitBriefDto> {
    const prep = await this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const v = await this.visitsSvc.load(tx, auth, scope, visitId);
      const a = await this.accountsSvc.loadAccount(tx, auth, { ...scope, readAll: true, restricted: false }, v.accountId);
      const g = await accountGrounding(tx, auth.tenantId, a);
      const entries = await this.brain.retrieve(tx, auth.tenantId, `${a.industry ?? ''} ${v.purpose ?? ''} ${a.city ?? ''}`, {
        sections: ['products', 'differentiators', 'objections', 'pricing', 'faq', 'competitors', 'onboarding_process'],
      });
      const forbidden = await this.brain.forbiddenPhrases(tx, auth.tenantId);
      const visitText = `## الزيارة\n- الموعد: ${v.scheduledStart.toISOString()}\n- الهدف المسجل: ${v.purpose ? untrusted('visit_purpose', redactPii(v.purpose)) : 'غير محدد'}`;
      return { grounding: merge({ text: visitText, refs: new Map() }, g, brainGrounding(entries)), forbidden };
    });

    const { output } = await this.runtime.run(auth, 'visit_brief', { entityType: 'visit', entityId: visitId }, async (ctx) => {
      await ctx.step('context', 'grounding', { refs: [...prep.grounding.refs.keys()] });
      const out = await ctx.call({
        system: `${BASE_RULES}
مهمتك: تجهيز بطاقة زيارة مختصرة لمندوب مبيعات ميداني تُقرأ خلال دقيقتين على الجوال.
- whyTarget: لماذا هذا العميل مهم، كل نقطة مع مراجع [..] من بيانات العميل.
- valuePoints و objections: من معرفة الشركة المعتمدة فقط، وكل عنصر يذكر مرجعاً واحداً brain:... أو doc:... في الحقل source.
- questions: أسئلة اكتشاف ذكية مناسبة لهذا العميل.
- cautions: ما يجب تجنبه (من القواعد والعبارات الممنوعة إن وجدت).
إذا لم تتوفر معرفة معتمدة فاترك valuePoints و objections فارغة.`,
        prompt: prep.grounding.text,
        effort: 'medium',
        schema: visitBriefSchema,
      });

      const removed: Removed[] = [];
      const refs = prep.grounding.refs;
      const brainRef = (s: string) => (s.startsWith('brain:') || s.startsWith('doc:')) && refs.has(s);
      const clean = (text: string) => {
        const hits = findForbidden(text, prep.forbidden);
        if (hits.length) removed.push({ text, reason: 'forbidden_phrase' });
        return !hits.length;
      };
      const ev = (ref: string): Evidence => ({ ref, label: refs.get(ref)! });
      const content: VisitBriefDto['content'] = {
        summary: clean(out.summary) ? out.summary : '',
        whyTarget: out.whyTarget
          .filter((w) => (toEvidence(refs, w.evidence).length ? true : (removed.push({ text: w.text, reason: 'no_source' }), false)))
          .filter((w) => clean(w.text))
          .map((w) => w.text),
        goals: out.goals.filter(clean),
        questions: out.questions.filter(clean),
        valuePoints: out.valuePoints
          .filter((p) => (brainRef(p.source) ? true : (removed.push({ text: p.text, reason: 'no_source' }), false)))
          .filter((p) => clean(p.text))
          .map((p) => ({ text: p.text, source: ev(p.source) })),
        objections: out.objections
          .filter((o) => (brainRef(o.source) ? true : (removed.push({ text: `${o.objection} — ${o.response}`, reason: 'no_source' }), false)))
          .filter((o) => clean(`${o.objection} ${o.response}`))
          .map((o) => ({ objection: o.objection, response: o.response, source: ev(o.source) })),
        cautions: out.cautions,
      };
      await ctx.step('validation', 'visit_brief', { removed: removed.length });
      const row = await this.db.tenant(auth, async (tx) => {
        const [r] = await tx.insert(visitBriefs).values({ tenantId: auth.tenantId, visitId, content, removed, agentRunId: ctx.runId }).returning();
        return r!;
      });
      return { output: this.briefDto(row) };
    });
    return output;
  }

  private briefDto(r: typeof visitBriefs.$inferSelect): VisitBriefDto {
    return { id: r.id, visitId: r.visitId, createdAt: r.createdAt.toISOString(), agentRunId: r.agentRunId, content: r.content as VisitBriefDto['content'], removed: r.removed as Removed[] };
  }

  async latestBrief(auth: TenantAuthContext, visitId: string): Promise<VisitBriefDto | null> {
    return this.db.tenant(auth, async (tx) => {
      await this.visitsSvc.load(tx, auth, await this.scopes.forRequest(tx, auth), visitId);
      const [r] = await tx.select().from(visitBriefs).where(and(eq(visitBriefs.tenantId, auth.tenantId), eq(visitBriefs.visitId, visitId))).orderBy(desc(visitBriefs.createdAt)).limit(1);
      return r ? this.briefDto(r) : null;
    });
  }

  // ================================================================ Meeting intelligence

  /** Voice-note transcripts of the visit (manual or automatic), read directly to keep modules decoupled. */
  private async transcripts(tx: Tx, tenantId: string, visitId: string): Promise<string[]> {
    const rows = await tx
      .select({ t: visitRecordings.transcript })
      .from(visitRecordings)
      .where(and(eq(visitRecordings.tenantId, tenantId), eq(visitRecordings.visitId, visitId), eq(visitRecordings.status, 'ready')));
    return rows.map((r) => r.t).filter((t): t is string => !!t);
  }

  /** Quote check: a "stated fact" must be copied from the notes (Arabic-normalized substring). */
  static quoteFound(notes: string, quote: string): boolean {
    const q = normalizeArabic(quote);
    return q.length >= 3 && normalizeArabic(notes).includes(q);
  }

  async meetingInsights(auth: TenantAuthContext, visitId: string): Promise<MeetingInsightsDto> {
    const prep = await this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const v = await this.visitsSvc.load(tx, auth, scope, visitId);
      if (v.status !== 'completed') throw new AppError(409, 'VISIT_NOT_COMPLETED', 'Record the visit outcome first');
      const transcripts = await this.transcripts(tx, auth.tenantId, visitId);
      const notesText = redactPii([v.notes ?? '', ...transcripts].filter(Boolean).join('\n\n'));
      if (notesText.trim().length < 20) throw new AppError(422, 'NOT_ENOUGH_NOTES', 'Write the meeting notes first');
      const a = await this.accountsSvc.loadAccount(tx, auth, { ...scope, readAll: true, restricted: false }, v.accountId);
      return { v, a, notesText };
    });

    const { output } = await this.runtime.run(auth, 'meeting_intel', { entityType: 'visit', entityId: visitId }, async (ctx) => {
      const out = await ctx.call({
        system: `${BASE_RULES}
مهمتك: تحليل ملاحظات اجتماع مبيعات كتبها المندوب.
- statedFacts: فقط ما قاله العميل صراحة، مع quote منسوخ حرفياً من الملاحظات. لا تضع استنتاجاً هنا.
- inferences: استنتاجاتك مع التعليل ودرجة ثقة 0-1.
- nextActions: خطوات تالية عملية مع عدد الأيام المقترح.
- interestLevel 1-5 و progressLikelihood 0-1 أو null إذا لم تكفِ المعلومات.`,
        prompt: `العميل: ${prep.a.name}${prep.a.industry ? ` (${prep.a.industry})` : ''}\nنتيجة الزيارة المسجلة: ${prep.v.outcome ?? '—'}\n\n## ملاحظات الاجتماع\n${untrusted('meeting_notes', prep.notesText)}`,
        effort: 'medium',
        schema: meetingSchema,
      });
      const removed: Removed[] = [];
      const statedFacts = out.statedFacts.filter((f) => (AgentsService.quoteFound(prep.notesText, f.quote) ? true : (removed.push({ text: `${f.value} — «${f.quote}»`, reason: 'quote_not_found' }), false)));
      await ctx.step('validation', 'meeting_intel', { removed: removed.length });
      const row = await this.db.tenant(auth, async (tx) => {
        const [r] = await tx
          .insert(meetingInsights)
          .values({
            tenantId: auth.tenantId, visitId, summary: out.summary, statedFacts, inferences: out.inferences, nextActions: out.nextActions,
            interestLevel: out.interestLevel, progressLikelihood: out.progressLikelihood, removed, agentRunId: ctx.runId,
          })
          .returning();
        await this.activity.record(tx, { tenantId: auth.tenantId, accountId: prep.v.accountId, type: 'ai_meeting_analysis', actorType: 'agent', actorUserId: auth.userId, refType: 'visit', refId: visitId, summary: out.summary.slice(0, 200) });
        return r!;
      });
      return { output: this.insightsDto(row) };
    });
    return output;
  }

  private insightsDto(r: typeof meetingInsights.$inferSelect): MeetingInsightsDto {
    return {
      id: r.id, visitId: r.visitId, createdAt: r.createdAt.toISOString(), agentRunId: r.agentRunId, summary: r.summary,
      statedFacts: r.statedFacts as MeetingInsightsDto['statedFacts'], inferences: r.inferences as MeetingInsightsDto['inferences'],
      nextActions: r.nextActions as MeetingInsightsDto['nextActions'], interestLevel: r.interestLevel, progressLikelihood: r.progressLikelihood,
      removed: r.removed as Removed[],
    };
  }

  async latestInsights(auth: TenantAuthContext, visitId: string): Promise<MeetingInsightsDto | null> {
    return this.db.tenant(auth, async (tx: Tx) => {
      await this.visitsSvc.load(tx, auth, await this.scopes.forRequest(tx, auth), visitId);
      const [r] = await tx.select().from(meetingInsights).where(and(eq(meetingInsights.tenantId, auth.tenantId), eq(meetingInsights.visitId, visitId))).orderBy(desc(meetingInsights.createdAt)).limit(1);
      return r ? this.insightsDto(r) : null;
    });
  }
}
