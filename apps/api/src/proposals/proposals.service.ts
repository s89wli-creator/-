import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  accounts, activities, brainItems, contacts, opportunities, proposalItems, proposals, proposalSequences, tenants, users, type ProposalStatus, type Tx,
} from '@rakan/db';
import {
  VAT_RATE, hasPermission, type PriceListItemDto, type ProposalDto, type ProposalItemDto, type ProposalSummaryDto, type ProposalWarning, type PublicProposalDto,
} from '@rakan/shared';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { FieldCryptoService } from '../common/field-crypto.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from '../crm/accounts.service';
import { ActivityService } from '../crm/activity.service';
import { ScopeService, type RecordScope } from '../crm/scope';
import { MailService } from '../identity/mail.service';
import { BrainService } from '../ai/brain.service';
import { BASE_RULES, findForbidden, untrusted } from '../ai/guards';
import { accountGrounding } from '../ai/context';
import { AiRuntimeService } from '../ai/runtime.service';
import { ToolGatewayService } from '../ai/tool-gateway.service';

type Row = typeof proposals.$inferSelect;
type ItemInput = {
  brainItemId?: string; name?: string; description?: string; unit?: string; quantity: number; unitPrice?: number; discountPct?: number;
};
type SendPayload = { proposalId: string; number: string; version: number; total: number; contactId: string | null };
interface PriceEntry { id: string; product: string; price: number; unit: string | null; currency: string; version: number }
interface DiscountRules { rep: number; manager: number }

const DEFAULT_VALID_DAYS = 30;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const todayRiyadh = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86400_000).toISOString().slice(0, 10);

/** Line and document totals. Prices are VAT-exclusive; VAT is added on the discounted subtotal. */
export function computeTotals(items: { quantity: number; unitPrice: number; discountPct: number }[], vatRate = VAT_RATE) {
  const lines = items.map((i) => {
    const gross = round2(i.quantity * i.unitPrice);
    const lineTotal = round2(gross * (1 - i.discountPct / 100));
    return { gross, lineTotal };
  });
  const subtotal = round2(lines.reduce((a, l) => a + l.lineTotal, 0));
  const discountTotal = round2(lines.reduce((a, l) => a + (l.gross - l.lineTotal), 0));
  const vatAmount = round2((subtotal * vatRate) / 100);
  return { lines, subtotal, discountTotal, vatAmount, total: round2(subtotal + vatAmount) };
}

const aiDraftSchema = z.object({
  title: z.string().min(2).max(200),
  intro: z.string().max(3000),
  items: z.array(z.object({ ref: z.string(), quantity: z.number().positive(), why: z.string().max(300) })).max(30),
  unmatchedNeeds: z.array(z.string().max(300)).max(20),
});

/**
 * Commercial proposals.
 * - Prices come from the approved Sales Brain price list (copied by the server, never by the model). A line
 *   off the price list is allowed but marked "manual price" for the approver.
 * - Discounts respect the approved discount rules (rep / manager limits).
 * - Nothing reaches the customer without an approved request (Tool Gateway, EXTERNAL). Approval issues a
 *   private link (and emails it when the contact has an email and has not opted out).
 * - The customer opens the link, sees exactly the approved version, and accepts or declines.
 */
@Injectable()
export class ProposalsService implements OnModuleInit {
  private readonly log = new Logger('Proposals');

  constructor(
    private readonly db: DbService,
    private readonly scopes: ScopeService,
    private readonly accountsSvc: AccountsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly gateway: ToolGatewayService,
    private readonly runtime: AiRuntimeService,
    private readonly brain: BrainService,
    private readonly crypto: FieldCryptoService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.gateway.register({
      name: 'send_proposal',
      actionType: 'send_proposal',
      risk: 'EXTERNAL',
      execute: (auth: TenantAuthContext, p: SendPayload) => this.executeSend(auth, p),
      onRejected: (auth: TenantAuthContext, p: SendPayload) => this.onRejected(auth, p),
    });
  }

  // ---------------------------------------------------------------- price list and rules

  async priceList(tx: Tx, tenantId: string): Promise<PriceEntry[]> {
    const rows = await tx
      .select()
      .from(brainItems)
      .where(and(eq(brainItems.tenantId, tenantId), eq(brainItems.section, 'pricing'), eq(brainItems.status, 'approved')))
      .orderBy(asc(brainItems.title));
    return rows.map((r) => {
      const f = r.fields as { product?: string; price?: number; unit?: string; currency?: string };
      return { id: r.id, product: f.product ?? r.title, price: Number(f.price ?? 0), unit: f.unit ?? null, currency: f.currency ?? 'SAR', version: r.version };
    });
  }

  async priceListDto(auth: TenantAuthContext): Promise<PriceListItemDto[]> {
    return this.db.tenant(auth, (tx) => this.priceList(tx, auth.tenantId));
  }

  private async discountRules(tx: Tx, tenantId: string): Promise<DiscountRules | null> {
    const [r] = await tx
      .select()
      .from(brainItems)
      .where(and(eq(brainItems.tenantId, tenantId), eq(brainItems.section, 'discount_rules'), eq(brainItems.status, 'approved')))
      .orderBy(desc(brainItems.approvedAt))
      .limit(1);
    if (!r) return null;
    const f = r.fields as { maxDiscountPctRep?: number; maxDiscountPctManager?: number };
    return { rep: Number(f.maxDiscountPctRep ?? 0), manager: Number(f.maxDiscountPctManager ?? 0) };
  }

  /** Default terms: the company's approved commercial policy, verbatim (never written by the model). */
  private async defaultTerms(tx: Tx, tenantId: string): Promise<string> {
    const rows = await tx
      .select({ title: brainItems.title, body: brainItems.body })
      .from(brainItems)
      .where(and(eq(brainItems.tenantId, tenantId), eq(brainItems.section, 'commercial_policy'), eq(brainItems.status, 'approved')))
      .orderBy(asc(brainItems.title));
    return rows.map((r) => `${r.title}\n${r.body}`.trim()).join('\n\n').slice(0, 10000);
  }

  private async resolveItems(tx: Tx, auth: TenantAuthContext, inputs: ItemInput[]) {
    const list = new Map((await this.priceList(tx, auth.tenantId)).map((p) => [p.id, p]));
    const rules = await this.discountRules(tx, auth.tenantId);
    const limit = rules ? (auth.role === 'rep' ? rules.rep : rules.manager) : 100;
    const resolved = inputs.map((i, n) => {
      const disc = i.discountPct ?? 0;
      if (disc > limit) throw new AppError(422, 'DISCOUNT_ABOVE_LIMIT', 'This discount is above the approved limit', { line: n + 1, limit });
      if (i.brainItemId) {
        const p = list.get(i.brainItemId);
        if (!p) throw new AppError(422, 'PRICE_NOT_APPROVED', 'This product is not on the approved price list', { line: n + 1 });
        return {
          sort: n, name: p.product, description: i.description ?? null, unit: p.unit, quantity: i.quantity, unitPrice: p.price, discountPct: disc,
          priceSource: 'price_list' as const, brainItemId: p.id, brainVersion: p.version,
        };
      }
      if (!i.name || i.unitPrice === undefined) throw badRequest('MANUAL_LINE_INCOMPLETE', 'A line off the price list needs a name and a price', { line: n + 1 });
      return {
        sort: n, name: i.name, description: i.description ?? null, unit: i.unit ?? null, quantity: i.quantity, unitPrice: i.unitPrice, discountPct: disc,
        priceSource: 'manual' as const, brainItemId: null, brainVersion: null,
      };
    });
    const totals = computeTotals(resolved);
    return { items: resolved.map((r, k) => ({ ...r, lineTotal: totals.lines[k]!.lineTotal })), totals };
  }

  // ---------------------------------------------------------------- loading and DTOs

  private async load(tx: Tx, auth: TenantAuthContext, scope: RecordScope, id: string, write = false): Promise<Row> {
    const [p] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, id)));
    if (!p) throw notFound('Proposal');
    await this.accountsSvc.loadAccount(tx, auth, scope, p.accountId, write); // same record scope as the customer
    return p;
  }

  private shareUrl(tenantId: string, p: Row): string | null {
    if (!p.shareTokenEnc || !['sent', 'accepted', 'declined'].includes(p.status)) return null;
    const token = this.crypto.decrypt(tenantId, p.shareTokenEnc);
    return token ? `${this.config.WEB_ORIGIN}/p/${token}` : null;
  }

  private async dto(tx: Tx, auth: TenantAuthContext, p: Row): Promise<ProposalDto> {
    const items = await tx
      .select()
      .from(proposalItems)
      .where(and(eq(proposalItems.tenantId, auth.tenantId), eq(proposalItems.proposalId, p.id)))
      .orderBy(asc(proposalItems.sort));
    const [acc] = await tx.select({ id: accounts.id, name: accounts.name }).from(accounts).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, p.accountId)));
    const [opp] = p.opportunityId
      ? await tx.select({ id: opportunities.id, name: opportunities.title }).from(opportunities).where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, p.opportunityId)))
      : [];
    const [con] = p.contactId ? await tx.select().from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, p.contactId))) : [];
    const names = new Map<string, string>();
    for (const uid of [p.ownerUserId, p.createdBy].filter(Boolean) as string[]) {
      const [u] = await tx.select({ n: users.fullName }).from(users).where(eq(users.id, uid));
      if (u) names.set(uid, u.n);
    }

    const warnings: ProposalWarning[] = [];
    if (['draft', 'pending_approval'].includes(p.status)) {
      const list = new Map((await this.priceList(tx, auth.tenantId)).map((x) => [x.id, x]));
      const rules = await this.discountRules(tx, auth.tenantId);
      if (!items.length) warnings.push({ code: 'no_items' });
      for (const i of items) {
        if (i.priceSource === 'manual') warnings.push({ code: 'manual_price', item: i.name });
        else {
          const cur = i.brainItemId ? list.get(i.brainItemId) : undefined;
          if (!cur || cur.price !== i.unitPrice) warnings.push({ code: 'price_changed', item: i.name, listPrice: cur?.price ?? 0 });
        }
        if (i.discountPct > 0 && !rules) warnings.push({ code: 'no_discount_policy' });
        if (rules && i.discountPct > rules.rep) warnings.push({ code: 'discount_above_rep_limit', item: i.name, limit: rules.rep });
      }
      if (con?.doNotContact) warnings.push({ code: 'contact_dnc' });
      else if (con && !this.crypto.decrypt(auth.tenantId, con.emailEnc)) warnings.push({ code: 'missing_contact_email' });
    }
    const uniq = [...new Map(warnings.map((w) => [JSON.stringify(w), w])).values()];

    return {
      id: p.id, number: p.number, title: p.title, intro: p.intro, terms: p.terms, currency: p.currency, vatRate: p.vatRate,
      subtotal: p.subtotal, discountTotal: p.discountTotal, vatAmount: p.vatAmount, total: p.total, validUntil: p.validUntil,
      expired: p.validUntil < todayRiyadh() && ['draft', 'pending_approval', 'sent'].includes(p.status),
      status: p.status, version: p.version, source: p.source, agentRunId: p.agentRunId, approvalRequestId: p.approvalRequestId,
      account: acc ?? { id: p.accountId, name: '—' }, opportunity: opp ?? null, contact: con ? { id: con.id, name: con.fullName } : null,
      ownerName: p.ownerUserId ? (names.get(p.ownerUserId) ?? null) : null, createdByName: p.createdBy ? (names.get(p.createdBy) ?? null) : null,
      items: items.map((i): ProposalItemDto => ({
        id: i.id, sort: i.sort, name: i.name, description: i.description, unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice,
        discountPct: i.discountPct, lineTotal: i.lineTotal, priceSource: i.priceSource, brainItemId: i.brainItemId,
      })),
      warnings: uniq, shareUrl: this.shareUrl(auth.tenantId, p), sentAt: p.sentAt?.toISOString() ?? null, viewedAt: p.viewedAt?.toISOString() ?? null,
      decidedAt: p.decidedAt?.toISOString() ?? null, decisionByName: p.decisionByName, decisionNote: p.decisionNote,
      createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- CRUD

  async list(auth: TenantAuthContext, q: { status?: ProposalStatus; accountId?: string }): Promise<ProposalSummaryDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const conds: SQL[] = [eq(proposals.tenantId, auth.tenantId), isNull(accounts.deletedAt)];
      if (q.status) conds.push(eq(proposals.status, q.status));
      if (q.accountId) conds.push(eq(proposals.accountId, q.accountId));
      if (scope.restricted && !scope.readAll) conds.push(eq(accounts.ownerMembershipId, scope.membershipId));
      const rows = await tx
        .select({ p: proposals, accountName: accounts.name, owner: users.fullName })
        .from(proposals)
        .innerJoin(accounts, and(eq(accounts.tenantId, proposals.tenantId), eq(accounts.id, proposals.accountId)))
        .leftJoin(users, eq(users.id, proposals.ownerUserId))
        .where(and(...conds))
        .orderBy(desc(proposals.updatedAt))
        .limit(300);
      const today = todayRiyadh();
      return rows.map(({ p, accountName, owner }) => ({
        id: p.id, number: p.number, title: p.title, status: p.status, total: p.total, currency: p.currency, validUntil: p.validUntil,
        expired: p.validUntil < today && ['draft', 'pending_approval', 'sent'].includes(p.status),
        account: { id: p.accountId, name: accountName }, ownerName: owner, updatedAt: p.updatedAt.toISOString(),
        sentAt: p.sentAt?.toISOString() ?? null, viewedAt: p.viewedAt?.toISOString() ?? null,
      }));
    });
  }

  async get(auth: TenantAuthContext, id: string): Promise<ProposalDto> {
    return this.db.tenant(auth, async (tx) => this.dto(tx, auth, await this.load(tx, auth, await this.scopes.forRequest(tx, auth), id)));
  }

  /** Checks that the opportunity and contact belong to the proposal's customer. */
  private async checkLinks(tx: Tx, auth: TenantAuthContext, accountId: string, opportunityId?: string | null, contactId?: string | null): Promise<void> {
    if (opportunityId) {
      const [o] = await tx.select({ a: opportunities.accountId }).from(opportunities).where(and(eq(opportunities.tenantId, auth.tenantId), eq(opportunities.id, opportunityId)));
      if (!o || o.a !== accountId) throw badRequest('INVALID_REFERENCE', 'The opportunity does not belong to this customer');
    }
    if (contactId) {
      const [c] = await tx.select({ a: contacts.accountId }).from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, contactId), isNull(contacts.deletedAt)));
      if (!c || c.a !== accountId) throw badRequest('INVALID_REFERENCE', 'The contact does not belong to this customer');
    }
  }

  private async nextNumber(tx: Tx, tenantId: string): Promise<string> {
    const r = await tx.execute(sql`
      INSERT INTO proposal_sequences (tenant_id, last) VALUES (${tenantId}, 1)
      ON CONFLICT (tenant_id) DO UPDATE SET last = proposal_sequences.last + 1 RETURNING last`);
    const n = Number((r.rows[0] as { last: number }).last);
    return `Q-${todayRiyadh().slice(0, 4)}-${String(n).padStart(4, '0')}`;
  }

  async create(
    auth: TenantAuthContext,
    input: { accountId: string; opportunityId?: string; contactId?: string; title: string; intro?: string; terms?: string; validUntil?: string; items: ItemInput[] },
    meta: RequestMeta,
    extra: { source?: 'user' | 'agent'; agentRunId?: string } = {},
  ): Promise<ProposalDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.accountsSvc.loadAccount(tx, auth, scope, input.accountId, true);
      await this.checkLinks(tx, auth, input.accountId, input.opportunityId, input.contactId);
      const validUntil = input.validUntil ?? addDays(todayRiyadh(), DEFAULT_VALID_DAYS);
      if (validUntil < todayRiyadh()) throw badRequest('INVALID_DATE', 'Validity date is in the past');
      const { items, totals } = await this.resolveItems(tx, auth, input.items);
      const [p] = await tx
        .insert(proposals)
        .values({
          tenantId: auth.tenantId, number: await this.nextNumber(tx, auth.tenantId), accountId: input.accountId, opportunityId: input.opportunityId ?? null,
          contactId: input.contactId ?? null, ownerUserId: auth.userId, title: input.title, intro: input.intro ?? '',
          terms: input.terms ?? (await this.defaultTerms(tx, auth.tenantId)), validUntil, vatRate: VAT_RATE,
          subtotal: totals.subtotal, discountTotal: totals.discountTotal, vatAmount: totals.vatAmount, total: totals.total,
          source: extra.source ?? 'user', agentRunId: extra.agentRunId ?? null, createdBy: auth.userId,
        })
        .returning();
      if (items.length) await tx.insert(proposalItems).values(items.map((i) => ({ ...i, tenantId: auth.tenantId, proposalId: p!.id })));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'proposal.create', entityType: 'proposal', entityId: p!.id,
        after: { number: p!.number, total: p!.total, source: p!.source }, meta,
      });
      return this.dto(tx, auth, p!);
    });
  }

  async update(
    auth: TenantAuthContext,
    id: string,
    input: { opportunityId?: string | null; contactId?: string | null; title?: string; intro?: string; terms?: string; validUntil?: string; items?: ItemInput[] },
    meta: RequestMeta,
  ): Promise<ProposalDto> {
    return this.db.tenant(auth, async (tx) => {
      const p = await this.load(tx, auth, await this.scopes.forRequest(tx, auth), id, true);
      if (p.status !== 'draft') throw conflict('INVALID_STATE', 'Only a draft can be edited');
      await this.checkLinks(tx, auth, p.accountId, input.opportunityId, input.contactId);
      if (input.validUntil && input.validUntil < todayRiyadh()) throw badRequest('INVALID_DATE', 'Validity date is in the past');
      const set: Partial<typeof proposals.$inferInsert> = { version: p.version + 1, updatedAt: new Date() };
      for (const k of ['opportunityId', 'contactId', 'title', 'intro', 'terms', 'validUntil'] as const) if (input[k] !== undefined) (set as Record<string, unknown>)[k] = input[k];
      if (input.items) {
        const { items, totals } = await this.resolveItems(tx, auth, input.items);
        await tx.delete(proposalItems).where(and(eq(proposalItems.tenantId, auth.tenantId), eq(proposalItems.proposalId, id)));
        if (items.length) await tx.insert(proposalItems).values(items.map((i) => ({ ...i, tenantId: auth.tenantId, proposalId: id })));
        Object.assign(set, { subtotal: totals.subtotal, discountTotal: totals.discountTotal, vatAmount: totals.vatAmount, total: totals.total });
      }
      const [r] = await tx.update(proposals).set(set).where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, id))).returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'proposal.update', entityType: 'proposal', entityId: id,
        before: { total: p.total, version: p.version }, after: { total: r!.total, version: r!.version }, meta,
      });
      return this.dto(tx, auth, r!);
    });
  }

  /** Asks for approval to send (EXTERNAL). The approved request carries the exact version and total. */
  async submit(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<ProposalDto> {
    const p = await this.db.tenant(auth, async (tx) => {
      const p = await this.load(tx, auth, await this.scopes.forRequest(tx, auth), id, true);
      if (p.status !== 'draft') throw conflict('INVALID_STATE', 'Only a draft can be submitted');
      if (p.validUntil < todayRiyadh()) throw new AppError(422, 'PROPOSAL_EXPIRED', 'The validity date has passed; update it first');
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(proposalItems).where(and(eq(proposalItems.tenantId, auth.tenantId), eq(proposalItems.proposalId, id)));
      if (!n?.n) throw new AppError(422, 'PROPOSAL_EMPTY', 'Add at least one line');
      return p;
    });
    const [acc] = await this.db.tenant(auth, (tx) => tx.select({ name: accounts.name }).from(accounts).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, p.accountId))));
    const payload: SendPayload = { proposalId: p.id, number: p.number, version: p.version, total: p.total, contactId: p.contactId };
    const res = await this.gateway.invoke(auth, 'send_proposal', payload, {
      summary: `إرسال عرض السعر ${p.number} إلى ${acc?.name ?? ''} بقيمة ${p.total.toLocaleString('en-US')} ${p.currency} شامل الضريبة`,
      requestedByType: p.source === 'agent' ? 'agent' : 'user', agentRunId: p.agentRunId, entityType: 'proposal', entityId: p.id,
    }, meta);
    return this.db.tenant(auth, async (tx) => {
      const [r] = await tx
        .update(proposals)
        .set({ status: 'pending_approval', approvalRequestId: res.status === 'pending_approval' ? res.approvalId : null, updatedAt: new Date() })
        .where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, id)))
        .returning();
      return this.dto(tx, auth, r!);
    });
  }

  /** Runs after approval, as the approver: issues the private link and emails it when allowed. */
  private async executeSend(auth: TenantAuthContext, p: SendPayload): Promise<Record<string, unknown>> {
    const token = randomBytes(24).toString('base64url');
    const out = await this.db.tenant(auth, async (tx) => {
      const [cur] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, p.proposalId)));
      if (!cur || cur.status !== 'pending_approval' || cur.version !== p.version || cur.total !== p.total) {
        throw new AppError(409, 'INVALID_STATE', 'The proposal changed after it was submitted');
      }
      const [r] = await tx
        .update(proposals)
        .set({ status: 'sent', sentAt: new Date(), shareTokenHash: tokenHash(token), shareTokenEnc: this.crypto.encrypt(auth.tenantId, token), updatedAt: new Date() })
        .where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, p.proposalId)))
        .returning();
      const [c] = p.contactId ? await tx.select().from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, p.contactId))) : [];
      const email = c && !c.doNotContact ? this.crypto.decrypt(auth.tenantId, c.emailEnc) : null; // DNC re-checked at send time
      const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, auth.tenantId));
      await this.activity.record(tx, {
        tenantId: auth.tenantId, accountId: r!.accountId, opportunityId: r!.opportunityId, type: 'proposal_sent', actorType: 'user', actorUserId: auth.userId,
        refType: 'proposal', refId: r!.id, summary: `${r!.number} · ${r!.total} ${r!.currency}`,
      });
      return { row: r!, email, contactName: c?.fullName ?? null, company: t?.name ?? '' };
    });
    const link = `${this.config.WEB_ORIGIN}/p/${token}`;
    if (out.email) {
      await this.mail.send({
        to: out.email,
        subject: `عرض سعر ${out.row.number} من ${out.company}`,
        text: `مرحباً ${out.contactName ?? ''}،\n\nيسعدنا مشاركتكم عرض السعر "${out.row.title}" بقيمة ${out.row.total.toLocaleString('en-US')} ${out.row.currency} شاملة ضريبة القيمة المضافة، وهو ساري حتى ${out.row.validUntil}.\n\nيمكنكم الاطلاع عليه وقبوله أو الاعتذار عنه من الرابط:\n${link}\n\nمع التحية،\n${out.company}`,
      });
    }
    return { sent: true, emailed: !!out.email, link };
  }

  private async onRejected(auth: TenantAuthContext, p: SendPayload): Promise<void> {
    await this.db.tenant(auth, (tx) =>
      tx
        .update(proposals)
        .set({ status: 'draft', approvalRequestId: null, updatedAt: new Date() })
        .where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, p.proposalId), eq(proposals.status, 'pending_approval'))),
    );
  }

  async cancel(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<ProposalDto> {
    return this.transition(auth, id, ['draft', 'sent'], 'cancelled', 'proposal.cancel', meta);
  }

  /** Back to a draft after the customer declined or it was cancelled: the old link stops working. */
  async revise(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<ProposalDto> {
    return this.transition(auth, id, ['declined', 'cancelled', 'sent'], 'draft', 'proposal.revise', meta);
  }

  private async transition(auth: TenantAuthContext, id: string, from: ProposalStatus[], to: ProposalStatus, action: string, meta: RequestMeta): Promise<ProposalDto> {
    return this.db.tenant(auth, async (tx) => {
      const p = await this.load(tx, auth, await this.scopes.forRequest(tx, auth), id, true);
      if (!from.includes(p.status)) throw conflict('INVALID_STATE', `Cannot move a ${p.status} proposal to ${to}`);
      const set: Partial<typeof proposals.$inferInsert> = { status: to, updatedAt: new Date() };
      if (to === 'draft') Object.assign(set, { shareTokenHash: null, shareTokenEnc: null, approvalRequestId: null, version: p.version + 1, decidedAt: null, decisionByName: null, decisionNote: null, viewedAt: null, sentAt: null });
      if (to === 'cancelled') Object.assign(set, { shareTokenHash: null, shareTokenEnc: null });
      const [r] = await tx.update(proposals).set(set).where(and(eq(proposals.tenantId, auth.tenantId), eq(proposals.id, id))).returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action, entityType: 'proposal', entityId: id, before: { status: p.status }, after: { status: to }, meta });
      return this.dto(tx, auth, r!);
    });
  }

  // ---------------------------------------------------------------- AI drafting

  async draftWithAi(
    auth: TenantAuthContext,
    input: { accountId: string; opportunityId?: string; contactId?: string; request: string },
    meta: RequestMeta,
  ): Promise<ProposalDto> {
    if (!hasPermission(auth.role, 'ai.use')) throw new AppError(403, 'FORBIDDEN', 'Missing permission ai.use');
    const prep = await this.db.tenant(auth, async (tx) => {
      const a = await this.accountsSvc.loadAccount(tx, auth, await this.scopes.forRequest(tx, auth), input.accountId, true);
      await this.checkLinks(tx, auth, input.accountId, input.opportunityId, input.contactId);
      const list = await this.priceList(tx, auth.tenantId);
      if (!list.length) throw new AppError(422, 'NO_PRICE_LIST', 'Approve at least one price in the Sales Brain first');
      const g = await accountGrounding(tx, auth.tenantId, a);
      const entries = await this.brain.retrieve(tx, auth.tenantId, input.request, { sections: ['products', 'differentiators', 'proposal_templates'] });
      return { list, account: g.text, entries, forbidden: await this.brain.forbiddenPhrases(tx, auth.tenantId), name: a.name };
    });
    const priceText = prep.list.map((p) => `- [price:${p.id}] ${p.product}: ${p.price} ${p.currency}${p.unit ? ` / ${p.unit}` : ''}`).join('\n');
    const brainText = prep.entries.map((e) => `- ${e.title}: ${e.text.slice(0, 800)}`).join('\n') || 'غير متوفر';

    const { output } = await this.runtime.run(auth, 'proposal', { entityType: 'account', entityId: input.accountId, input: { request: input.request.slice(0, 200) } }, async (ctx) => {
      const out = await ctx.call({
        system: `${BASE_RULES}
مهمتك: تجهيز مسودة عرض سعر للعميل "${prep.name}".
- اختر البنود من "قائمة الأسعار المعتمدة" فقط، باستخدام المرجع [price:...] كما هو، وحدد الكمية المناسبة لطلب العميل.
- لا تكتب أي سعر أو خصم: الأسعار يضعها النظام من القائمة، والخصومات يقررها المندوب.
- أي احتياج للعميل لا يقابله بند في القائمة ضعه في unmatchedNeeds ولا تخترع له بنداً.
- intro: فقرة تقديم قصيرة ومهنية بالفصحى موجهة للعميل، دون أرقام أو أسعار أو وعود غير موجودة في معرفة الشركة.
- هذه مسودة سيراجعها إنسان، ولن تُرسل إلا بعد الموافقة.`,
        prompt: `## قائمة الأسعار المعتمدة\n${priceText}\n\n## معرفة الشركة المعتمدة\n${brainText}\n\n${prep.account}\n\n## طلب المندوب (ما يحتاجه العميل)\n${untrusted('rep_request', input.request)}`,
        effort: 'medium',
        schema: aiDraftSchema,
      });
      const known = new Map(prep.list.map((p) => [`price:${p.id}`, p]));
      const strip = (r: string) => r.replace(/^\[|\]$/g, '').trim();
      const kept = out.items.filter((i) => known.has(strip(i.ref)));
      const dropped = out.items.filter((i) => !known.has(strip(i.ref))).map((i) => `${i.why} (مرجع غير موجود في القائمة)`);
      const hits = findForbidden(`${out.title}\n${out.intro}`, prep.forbidden);
      await ctx.step('validation', 'proposal', { kept: kept.length, dropped: dropped.length, forbiddenHits: hits.length });
      const intro = hits.length ? '' : out.intro; // never keep text that uses a forbidden phrase
      const draft = await this.create(
        auth,
        {
          accountId: input.accountId, opportunityId: input.opportunityId, contactId: input.contactId, title: out.title, intro,
          items: kept.map((i) => ({ brainItemId: known.get(strip(i.ref))!.id, quantity: i.quantity, description: i.why })),
        },
        meta,
        { source: 'agent', agentRunId: ctx.runId },
      );
      return { output: { ...draft, unmatchedNeeds: [...out.unmatchedNeeds, ...dropped, ...(hits.length ? ['حُذفت فقرة التقديم لاحتوائها عبارة ممنوعة'] : [])] } };
    });
    return output;
  }

  // ---------------------------------------------------------------- customer link (public)

  private async byToken(token: string): Promise<{ tenantId: string; id: string } | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const r = await this.db.platform((tx) => tx.execute(sql`SELECT * FROM proposal_by_token(${tokenHash(token)})`));
    const row = r.rows[0] as { tenant_id: string; proposal_id: string } | undefined;
    return row ? { tenantId: row.tenant_id, id: row.proposal_id } : null;
  }

  private async publicDto(tx: Tx, tenantId: string, p: Row): Promise<PublicProposalDto> {
    const items = await tx.select().from(proposalItems).where(and(eq(proposalItems.tenantId, tenantId), eq(proposalItems.proposalId, p.id))).orderBy(asc(proposalItems.sort));
    const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
    const [a] = await tx.select({ name: accounts.name }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, p.accountId)));
    const [o] = p.ownerUserId ? await tx.select({ n: users.fullName }).from(users).where(eq(users.id, p.ownerUserId)) : [];
    return {
      number: p.number, title: p.title, intro: p.intro, terms: p.terms, currency: p.currency, vatRate: p.vatRate, subtotal: p.subtotal,
      discountTotal: p.discountTotal, vatAmount: p.vatAmount, total: p.total, validUntil: p.validUntil,
      expired: p.status === 'sent' && p.validUntil < todayRiyadh(), status: p.status as PublicProposalDto['status'],
      companyName: t?.name ?? '', customerName: a?.name ?? '', preparedBy: o?.n ?? null,
      items: items.map((i) => ({ name: i.name, description: i.description, unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice, discountPct: i.discountPct, lineTotal: i.lineTotal })),
      sentAt: p.sentAt?.toISOString() ?? null, decidedAt: p.decidedAt?.toISOString() ?? null, decisionByName: p.decisionByName,
    };
  }

  async publicView(token: string): Promise<PublicProposalDto> {
    const ref = await this.byToken(token);
    if (!ref) throw notFound('Proposal');
    return this.db.run({ tenantId: ref.tenantId }, async (tx) => {
      const [p] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, ref.tenantId), eq(proposals.id, ref.id)));
      if (!p || !['sent', 'accepted', 'declined'].includes(p.status)) throw notFound('Proposal');
      if (!p.viewedAt) {
        await tx.update(proposals).set({ viewedAt: new Date() }).where(and(eq(proposals.tenantId, ref.tenantId), eq(proposals.id, p.id)));
        await this.activity.record(tx, { tenantId: ref.tenantId, accountId: p.accountId, opportunityId: p.opportunityId, type: 'proposal_viewed', actorType: 'system', refType: 'proposal', refId: p.id, summary: p.number });
      }
      return this.publicDto(tx, ref.tenantId, p);
    });
  }

  async publicDecide(token: string, input: { decision: 'accept' | 'decline'; name: string; note?: string }, meta: RequestMeta): Promise<PublicProposalDto> {
    const ref = await this.byToken(token);
    if (!ref) throw notFound('Proposal');
    return this.db.run({ tenantId: ref.tenantId }, async (tx) => {
      const [p] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, ref.tenantId), eq(proposals.id, ref.id))).for('update');
      if (!p || !['sent', 'accepted', 'declined'].includes(p.status)) throw notFound('Proposal');
      if (p.status !== 'sent') throw conflict('ALREADY_DECIDED', 'This proposal was already answered');
      if (p.validUntil < todayRiyadh()) throw new AppError(422, 'PROPOSAL_EXPIRED', 'This proposal has expired');
      const status = input.decision === 'accept' ? 'accepted' : 'declined';
      const [r] = await tx
        .update(proposals)
        .set({ status, decidedAt: new Date(), decisionByName: input.name, decisionNote: input.note ?? null, updatedAt: new Date() })
        .where(and(eq(proposals.tenantId, ref.tenantId), eq(proposals.id, p.id)))
        .returning();
      await this.activity.record(tx, {
        tenantId: ref.tenantId, accountId: p.accountId, opportunityId: p.opportunityId, type: status === 'accepted' ? 'proposal_accepted' : 'proposal_declined',
        actorType: 'system', refType: 'proposal', refId: p.id, summary: `${p.number} · ${input.name}${input.note ? ` · ${input.note.slice(0, 200)}` : ''}`,
      });
      await this.audit.record(tx, {
        tenantId: ref.tenantId, actorType: 'system', action: `proposal.customer_${input.decision}`, entityType: 'proposal', entityId: p.id,
        after: { by: input.name, note: input.note ?? null, total: p.total, version: p.version }, meta,
      });
      return this.publicDto(tx, ref.tenantId, r!);
    });
  }
}
