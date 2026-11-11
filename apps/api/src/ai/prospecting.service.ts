import { Injectable } from '@nestjs/common';
import { prospectSearches, prospects, users, type Tx } from '@rakan/db';
import {
  accountSchema, normalizeArabic, normalizeCompanyName, normalizeDomain, normalizePhone,
  type ProspectDto, type ProspectSearchDto,
} from '@rakan/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, forbidden, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from '../crm/accounts.service';
import { findDuplicate } from '../crm/duplicates';
import { BrainService } from './brain.service';
import { brainGrounding } from './context';
import { BASE_RULES, redactPii, untrusted } from './guards';
import { AiRuntimeService } from './runtime.service';

const candidateSchema = z.object({
  candidates: z.array(
    z.object({
      name: z.string(),
      website: z.string().nullable(),
      city: z.string().nullable(),
      region: z.string().nullable(),
      industry: z.string().nullable(),
      phone: z.string().nullable().describe('Only a public company number shown in the source; never a personal mobile'),
      whyFit: z.string().describe('Why this company may need our services, based on the source and approved company knowledge'),
      fitEvidence: z.array(z.object({ text: z.string(), ref: z.string().describe('brain:... reference') })),
      sourceUrl: z.string().describe('The exact URL of the search result where this company was found ("manual" for supplied text)'),
      confidence: z.number().min(0).max(1),
    }),
  ),
});
type Candidate = z.infer<typeof candidateSchema>['candidates'][number];
type Dropped = { name: string; reason: string };

/** URL equality for citations: same host + path (case-insensitive host, no fragment, no trailing slash). */
export function sameUrl(a: string, b: string): boolean {
  const n = (u: string) => {
    try {
      const x = new URL(u.trim());
      return `${x.host.toLowerCase().replace(/^www\./, '')}${decodeURIComponent(x.pathname).replace(/\/+$/, '')}${x.search}`;
    } catch {
      return null;
    }
  };
  const na = n(a);
  return !!na && na === n(b);
}

/**
 * Prospecting agent: proposes NEW potential customers, never invents them.
 * - web_search: the provider searches the public web; every candidate must cite a URL that the search actually
 *   returned (checked in code). Unverifiable candidates are dropped and listed with the reason.
 * - manual: the company pastes text it may use (an exhibitor list, a directory page); every candidate must appear in it.
 * Candidates matching an existing account are flagged as duplicates; nothing becomes an account until a person accepts it.
 */
@Injectable()
export class ProspectingService {
  constructor(
    private readonly db: DbService,
    private readonly runtime: AiRuntimeService,
    private readonly brain: BrainService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  private assertCanCreate(auth: TenantAuthContext) {
    if (!auth.permissions.includes('crm.account.write')) throw forbidden('You cannot add accounts');
  }

  async search(auth: TenantAuthContext, input: { query: string; city?: string; limit: number }, meta: RequestMeta): Promise<ProspectSearchDto> {
    this.assertCanCreate(auth);
    return this.run(auth, { source: 'web_search', query: input.query, city: input.city ?? null, limit: input.limit }, meta);
  }

  async fromText(auth: TenantAuthContext, input: { text: string; sourceLabel: string }, meta: RequestMeta): Promise<ProspectSearchDto> {
    this.assertCanCreate(auth);
    return this.run(auth, { source: 'manual', query: input.sourceLabel, city: null, limit: 10, text: input.text }, meta);
  }

  private async run(
    auth: TenantAuthContext,
    p: { source: 'web_search' | 'manual'; query: string; city: string | null; limit: number; text?: string },
    meta: RequestMeta,
  ): Promise<ProspectSearchDto> {
    const prep = await this.db.tenant(auth, async (tx) => {
      const [s] = await tx
        .insert(prospectSearches)
        .values({ tenantId: auth.tenantId, query: p.query, city: p.city, source: p.source, requestedBy: auth.userId })
        .returning();
      const entries = await this.brain.retrieve(tx, auth.tenantId, `${p.query} ${p.city ?? ''}`, {
        sections: ['icp', 'non_fit', 'target_segments', 'target_regions', 'products', 'company_profile'],
      });
      const existing = await tx
        .select({ name: prospects.name })
        .from(prospects)
        .where(and(eq(prospects.tenantId, auth.tenantId), inArray(prospects.status, ['pending_review', 'rejected'])))
        .limit(500);
      return { search: s!, grounding: brainGrounding(entries), known: new Set(existing.map((x) => normalizeCompanyName(x.name))) };
    });

    try {
      const { runId, output } = await this.runtime.run(auth, 'prospecting', { entityType: 'prospect_search', entityId: prep.search.id, input: { source: p.source, query: p.query } }, async (ctx) => {
        await ctx.step('context', 'grounding', { refs: [...prep.grounding.refs.keys()], source: p.source });
        const system = `${BASE_RULES}
مهمتك: اقتراح شركات جديدة قد تكون عملاء مناسبين لهذه الشركة، في المملكة العربية السعودية.
- اقترح فقط شركات وجدتها فعلاً في ${p.source === 'web_search' ? 'نتائج البحث، مع رابط الصفحة نفسها في sourceUrl كما ظهر في النتائج' : 'النص المقدَّم داخل <untrusted_data>، واكتب "manual" في sourceUrl'}.
- لا تخمّن أرقام هواتف أو مواقع؛ إن لم تظهر في المصدر فاتركها null. لا تضع أرقام جوال شخصية أو أسماء أفراد.
- استبعد من يطابق وصف "العملاء غير المناسبين" المعتمد.
- whyFit مختصر؛ و fitEvidence يستشهد ببنود معرفة الشركة المعتمدة brain:... فقط.
- الحد الأقصى ${p.limit} شركات. إن لم تجد مصدراً موثوقاً فأعد قائمة فارغة.`;
        const prompt = `${prep.grounding.text}\n\n## المطلوب\n${p.query}${p.city ? `\nالمدينة: ${p.city}` : ''}${
          p.text ? `\n\n## النص المقدَّم\n${untrusted('company_supplied_list', redactPii(p.text))}` : ''
        }`;
        const { output, sources } = p.source === 'web_search'
          ? await ctx.search({ system, prompt, schema: candidateSchema, effort: 'medium', webSearch: { maxUses: 5, country: 'SA', city: p.city ?? undefined } })
          : { output: await ctx.call({ system, prompt, schema: candidateSchema, effort: 'medium' }), sources: [] };

        const dropped: Dropped[] = [];
        const kept: (Candidate & { sourceTitle: string | null })[] = [];
        const seen = new Set<string>();
        for (const c of output.candidates) {
          const key = normalizeCompanyName(c.name);
          if (!key) continue;
          if (p.source === 'web_search') {
            const src = sources.find((s) => sameUrl(s.url, c.sourceUrl));
            if (!src) { dropped.push({ name: c.name, reason: 'source_not_in_results' }); continue; }
            kept.push({ ...c, sourceUrl: src.url, sourceTitle: src.title || null });
          } else {
            if (!normalizeArabic(p.text!).includes(normalizeArabic(c.name))) { dropped.push({ name: c.name, reason: 'not_in_text' }); continue; }
            kept.push({ ...c, sourceUrl: `manual:${prep.search.id}`, sourceTitle: p.query });
          }
          if (seen.has(key) || prep.known.has(key)) { kept.pop(); dropped.push({ name: c.name, reason: 'already_proposed' }); continue; }
          seen.add(key);
        }
        await ctx.step('validation', 'prospecting', { proposed: output.candidates.length, kept: kept.length, dropped: dropped.length, sourcesReturned: sources.length });

        const saved = await this.db.tenant(auth, async (tx) => {
          let n = 0;
          for (const c of kept.slice(0, p.limit)) {
            const domain = normalizeDomain(c.website);
            const phone = normalizePhone(c.phone);
            const dup = await findDuplicate(tx, auth.tenantId, { name: c.name, nameNormalized: normalizeCompanyName(c.name), websiteDomain: domain, phone, city: c.city });
            const evidence = c.fitEvidence
              .filter((e) => e.ref.startsWith('brain:') && prep.grounding.refs.has(e.ref))
              .map((e) => ({ text: e.text, ref: e.ref, label: prep.grounding.refs.get(e.ref)! }));
            await tx.insert(prospects).values({
              tenantId: auth.tenantId, searchId: prep.search.id, name: c.name.trim().slice(0, 200), websiteDomain: domain,
              city: c.city?.slice(0, 80) ?? null, region: c.region?.slice(0, 80) ?? null, industry: c.industry?.slice(0, 120) ?? null, phone,
              whyFit: c.whyFit.slice(0, 1000), fitEvidence: evidence, sourceUrl: c.sourceUrl.slice(0, 2000), sourceTitle: c.sourceTitle?.slice(0, 300) ?? null,
              // Unsupported fit claims lower the confidence the model reported.
              confidence: Math.round(Math.min(1, Math.max(0, c.confidence)) * (evidence.length ? 1 : 0.6) * 1000) / 1000,
              duplicateOfAccountId: dup?.id ?? null,
            });
            n++;
          }
          await tx.update(prospectSearches).set({ status: 'done', found: n, dropped, agentRunId: ctx.runId }).where(and(eq(prospectSearches.tenantId, auth.tenantId), eq(prospectSearches.id, prep.search.id)));
          return n;
        });
        return { output: { found: saved } };
      });
      void runId;
      void output;
      await this.db.tenant(auth, (tx) =>
        this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'prospecting.search', entityType: 'prospect_search', entityId: prep.search.id, after: { source: p.source, query: p.query }, meta }),
      );
    } catch (e) {
      await this.db.tenant(auth, (tx) => tx.update(prospectSearches).set({ status: 'failed' }).where(and(eq(prospectSearches.tenantId, auth.tenantId), eq(prospectSearches.id, prep.search.id))));
      throw e;
    }
    return (await this.searches(auth)).find((s) => s.id === prep.search.id)!;
  }

  async searches(auth: TenantAuthContext): Promise<ProspectSearchDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select({ s: prospectSearches, name: users.fullName })
        .from(prospectSearches)
        .leftJoin(users, eq(users.id, prospectSearches.requestedBy))
        .where(eq(prospectSearches.tenantId, auth.tenantId))
        .orderBy(desc(prospectSearches.createdAt))
        .limit(30);
      return rows.map(({ s, name }) => ({
        id: s.id, query: s.query, city: s.city, source: s.source, status: s.status, found: s.found, dropped: s.dropped,
        requestedByName: name, createdAt: s.createdAt.toISOString(),
      }));
    });
  }

  private async dto(tx: Tx, rows: (typeof prospects.$inferSelect)[]): Promise<ProspectDto[]> {
    const out: ProspectDto[] = [];
    for (const r of rows) {
      let duplicateOf: ProspectDto['duplicateOf'] = null;
      if (r.duplicateOfAccountId) {
        const a = await this.accounts.nameOf(tx, r.tenantId, r.duplicateOfAccountId);
        if (a) duplicateOf = { id: r.duplicateOfAccountId, name: a };
      }
      const [u] = r.reviewedBy ? await tx.select({ n: users.fullName }).from(users).where(eq(users.id, r.reviewedBy)) : [];
      out.push({
        id: r.id, searchId: r.searchId, name: r.name, websiteDomain: r.websiteDomain, city: r.city, region: r.region, industry: r.industry, phone: r.phone,
        whyFit: r.whyFit, fitEvidence: r.fitEvidence, sourceUrl: r.sourceUrl, sourceTitle: r.sourceTitle, retrievedAt: r.retrievedAt.toISOString(),
        confidence: r.confidence, duplicateOf, status: r.status, accountId: r.accountId, reviewedByName: u?.n ?? null, rejectReason: r.rejectReason,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }

  async list(auth: TenantAuthContext, status?: string): Promise<ProspectDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select()
        .from(prospects)
        .where(and(eq(prospects.tenantId, auth.tenantId), status ? eq(prospects.status, status as ProspectDto['status']) : undefined))
        .orderBy(desc(prospects.createdAt))
        .limit(200);
      return this.dto(tx, rows);
    });
  }

  private async load(tx: Tx, auth: TenantAuthContext, id: string) {
    const [r] = await tx.select().from(prospects).where(and(eq(prospects.tenantId, auth.tenantId), eq(prospects.id, id)));
    if (!r) throw notFound('Prospect');
    if (r.status !== 'pending_review') throw new AppError(409, 'INVALID_STATE', 'Already reviewed');
    return r;
  }

  /** A person accepts: the prospect becomes an account (source recorded), assigned to the reviewer if they are a rep. */
  async accept(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<ProspectDto> {
    this.assertCanCreate(auth);
    const p = await this.db.tenant(auth, (tx) => this.load(tx, auth, id));
    const input = accountSchema.parse({
      name: p.name, city: p.city, region: p.region, industry: p.industry, website: p.websiteDomain, phone: p.phone,
      leadSource: 'prospecting', leadSourceDetail: p.sourceUrl.startsWith('manual:') ? (p.sourceTitle ?? 'إدخال يدوي').slice(0, 200) : p.sourceUrl.slice(0, 200),
    });
    const account = await this.accounts.create(auth, input, false, meta);
    return this.db.tenant(auth, async (tx) => {
      const [r] = await tx
        .update(prospects)
        .set({ status: 'accepted', accountId: account.id, reviewedBy: auth.userId, reviewedAt: new Date() })
        .where(and(eq(prospects.tenantId, auth.tenantId), eq(prospects.id, id)))
        .returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'prospecting.accept', entityType: 'prospect', entityId: id, after: { accountId: account.id, source: p.sourceUrl }, meta });
      return (await this.dto(tx, [r!]))[0]!;
    });
  }

  async reject(auth: TenantAuthContext, id: string, reason: string, meta: RequestMeta): Promise<ProspectDto> {
    this.assertCanCreate(auth);
    return this.db.tenant(auth, async (tx) => {
      await this.load(tx, auth, id);
      const [r] = await tx
        .update(prospects)
        .set({ status: 'rejected', rejectReason: reason, reviewedBy: auth.userId, reviewedAt: new Date() })
        .where(and(eq(prospects.tenantId, auth.tenantId), eq(prospects.id, id)))
        .returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'prospecting.reject', entityType: 'prospect', entityId: id, after: { reason }, meta });
      return (await this.dto(tx, [r!]))[0]!;
    });
  }
}
