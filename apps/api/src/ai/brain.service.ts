import { Injectable } from '@nestjs/common';
import { brainChunks, brainDocuments, brainItems, brainItemVersions, users, type Tx } from '@rakan/db';
import {
  BRAIN_SECTIONS, brainFieldSchemas, normalizeArabic,
  type BrainDocumentDto, type BrainItemDto, type BrainItemInput, type BrainOverviewDto, type BrainSection,
} from '@rakan/shared';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { findForbidden, scanInjection } from './guards';

type ItemRow = typeof brainItems.$inferSelect;

/** Arabic search tokens: each word plus its form without common prefixes (ال، وال، بال، لل). */
function tokens(s: string): string[] {
  const out = new Set<string>();
  for (const w of normalizeArabic(s).split(' ')) {
    if (w.length < 2) continue;
    out.add(w);
    const stripped = w.replace(/^(وال|بال|كال|فال|لل|ال)(?=..)/, '');
    if (stripped !== w) out.add(stripped);
  }
  return [...out];
}
export const searchText = (...parts: string[]) => tokens(parts.join(' ')).join(' ');
/** OR-query with prefix matching; only letters/digits survive normalization, so the tsquery is safe. */
export function tsQuery(q: string): string | null {
  const t = tokens(q).filter((w) => w.length >= 2).slice(0, 24);
  return t.length ? t.map((w) => `${w}:*`).join(' | ') : null;
}

/** Sections every agent always receives (rules that apply regardless of the question). */
export const ALWAYS_SECTIONS: BrainSection[] = ['forbidden', 'discount_rules', 'rep_authority', 'tone', 'commercial_policy'];

export interface BrainEntry { id: string; section: string; title: string; text: string }

function chunk(content: string, size = 1200): string[] {
  const paras = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) {
      out.push(cur);
      cur = '';
    }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
    } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

@Injectable()
export class BrainService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private validateFields(section: BrainSection, fields: Record<string, unknown>): Record<string, unknown> {
    const schema = brainFieldSchemas[section];
    if (!schema) return {};
    const r = schema.safeParse(fields);
    if (!r.success) throw badRequest('VALIDATION_ERROR', 'Invalid fields', r.error.issues.map((i) => ({ path: 'fields.' + i.path.join('.'), message: i.message })));
    return r.data as Record<string, unknown>;
  }

  private itemDto(r: ItemRow, approvedByName: string | null, conflicts: BrainOverviewDto['conflicts']): BrainItemDto {
    return {
      id: r.id, section: r.section as BrainSection, trackId: r.trackId, title: r.title, body: r.body, fields: r.fields, status: r.status,
      sourceType: r.sourceType, version: r.version, approvedByName, approvedAt: r.approvedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      conflicts: conflicts.filter((c) => c.a === r.id || c.b === r.id).map((c) => ({ itemId: c.a === r.id ? c.b : c.a, reason: c.reason })),
    };
  }

  private docDto(d: typeof brainDocuments.$inferSelect): BrainDocumentDto {
    return {
      id: d.id, title: d.title, filename: d.filename, trustLevel: d.trustLevel, injectionFlags: d.injectionFlags, chars: d.content.length,
      createdAt: d.createdAt.toISOString(), approvedAt: d.approvedAt?.toISOString() ?? null,
    };
  }

  /** Contradictions the company must resolve before agents rely on them. */
  detectConflicts(items: ItemRow[]): BrainOverviewDto['conflicts'] {
    const live = items.filter((i) => i.status !== 'archived');
    const out: BrainOverviewDto['conflicts'] = [];
    const prices = live.filter((i) => i.section === 'pricing');
    for (let x = 0; x < prices.length; x++) {
      for (let y = x + 1; y < prices.length; y++) {
        const a = prices[x]!, b = prices[y]!;
        const fa = a.fields as { product?: string; price?: number; unit?: string }, fb = b.fields as typeof fa;
        if (fa.product && fb.product && normalizeArabic(fa.product) === normalizeArabic(fb.product) && (fa.unit ?? '') === (fb.unit ?? '') && fa.price !== fb.price) {
          out.push({ a: a.id, b: b.id, reason: 'price_mismatch' });
        }
      }
    }
    const discounts = live.filter((i) => i.section === 'discount_rules');
    for (let x = 1; x < discounts.length; x++) out.push({ a: discounts[0]!.id, b: discounts[x]!.id, reason: 'multiple_discount_rules' });
    const phrases = live.filter((i) => i.section === 'forbidden').map((i) => ({ id: i.id, phrase: String((i.fields as { phrase?: string }).phrase ?? i.title) }));
    for (const it of live.filter((i) => i.section !== 'forbidden')) {
      for (const p of phrases) if (findForbidden(`${it.title}\n${it.body}`, [p.phrase]).length) out.push({ a: it.id, b: p.id, reason: 'uses_forbidden_phrase' });
    }
    return out;
  }

  async overview(auth: TenantAuthContext): Promise<BrainOverviewDto> {
    return this.db.tenant(auth, async (tx) => {
      const rows = await tx
        .select({ r: brainItems, approver: users.fullName })
        .from(brainItems)
        .leftJoin(users, eq(users.id, brainItems.approvedBy))
        .where(eq(brainItems.tenantId, auth.tenantId))
        .orderBy(asc(brainItems.section), desc(brainItems.updatedAt));
      const docs = await tx.select().from(brainDocuments).where(eq(brainDocuments.tenantId, auth.tenantId)).orderBy(desc(brainDocuments.createdAt));
      const conflicts = this.detectConflicts(rows.map((x) => x.r));
      const coverage = BRAIN_SECTIONS.map((section) => {
        const inSection = rows.filter((x) => x.r.section === section && x.r.status !== 'archived');
        return { section, approved: inSection.filter((x) => x.r.status === 'approved').length, total: inSection.length };
      });
      return { items: rows.map((x) => this.itemDto(x.r, x.approver, conflicts)), documents: docs.map((d) => this.docDto(d)), coverage, conflicts };
    });
  }

  private async loadItem(tx: Tx, tenantId: string, id: string): Promise<ItemRow> {
    const [r] = await tx.select().from(brainItems).where(and(eq(brainItems.tenantId, tenantId), eq(brainItems.id, id)));
    if (!r) throw notFound('Item');
    return r;
  }

  private async snapshot(tx: Tx, r: ItemRow, userId: string): Promise<void> {
    await tx.insert(brainItemVersions).values({
      tenantId: r.tenantId, brainItemId: r.id, version: r.version, title: r.title, body: r.body, fields: r.fields, status: r.status, changedBy: userId,
    });
  }

  async create(auth: TenantAuthContext, input: BrainItemInput, meta: RequestMeta): Promise<BrainItemDto> {
    const fields = this.validateFields(input.section, input.fields);
    return this.db.tenant(auth, async (tx) => {
      const [r] = await tx
        .insert(brainItems)
        .values({
          tenantId: auth.tenantId, section: input.section, trackId: input.trackId ?? null, title: input.title, body: input.body, fields,
          status: input.status, searchText: searchText(input.title, input.body, JSON.stringify(fields)), updatedBy: auth.userId,
        })
        .returning();
      await this.snapshot(tx, r!, auth.userId);
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'brain.item.create', entityType: 'brain_item', entityId: r!.id, after: { section: r!.section, title: r!.title }, meta });
      return this.itemDto(r!, null, []);
    });
  }

  /** Any edit creates a new version; an approved item goes back to "pending confirmation" until re-approved. */
  async update(auth: TenantAuthContext, id: string, input: Partial<Omit<BrainItemInput, 'section'>>, meta: RequestMeta): Promise<BrainItemDto> {
    return this.db.tenant(auth, async (tx) => {
      const cur = await this.loadItem(tx, auth.tenantId, id);
      if (cur.status === 'archived') throw new AppError(409, 'INVALID_STATE', 'Archived items cannot be edited');
      const fields = input.fields ? this.validateFields(cur.section as BrainSection, input.fields) : cur.fields;
      const title = input.title ?? cur.title;
      const body = input.body ?? cur.body;
      const status = cur.status === 'approved' ? 'pending_confirmation' : (input.status ?? cur.status);
      const [r] = await tx
        .update(brainItems)
        .set({
          title, body, fields, status, trackId: input.trackId === undefined ? cur.trackId : input.trackId, version: cur.version + 1,
          searchText: searchText(title, body, JSON.stringify(fields)), approvedBy: null, approvedAt: null, updatedBy: auth.userId, updatedAt: new Date(),
        })
        .where(and(eq(brainItems.tenantId, auth.tenantId), eq(brainItems.id, id)))
        .returning();
      await this.snapshot(tx, r!, auth.userId);
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'brain.item.update', entityType: 'brain_item', entityId: id,
        before: { title: cur.title, body: cur.body, fields: cur.fields, version: cur.version }, after: { title, body, fields, version: r!.version }, meta,
      });
      return this.itemDto(r!, null, []);
    });
  }

  async setStatus(auth: TenantAuthContext, id: string, status: 'approved' | 'archived', meta: RequestMeta): Promise<BrainItemDto> {
    return this.db.tenant(auth, async (tx) => {
      const cur = await this.loadItem(tx, auth.tenantId, id);
      if (cur.status === status) throw new AppError(409, 'INVALID_STATE', 'Already in this state');
      const approved = status === 'approved';
      const [r] = await tx
        .update(brainItems)
        .set({ status, approvedBy: approved ? auth.userId : cur.approvedBy, approvedAt: approved ? new Date() : cur.approvedAt, updatedAt: new Date() })
        .where(and(eq(brainItems.tenantId, auth.tenantId), eq(brainItems.id, id)))
        .returning();
      await this.snapshot(tx, r!, auth.userId);
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: approved ? 'brain.item.approve' : 'brain.item.archive', entityType: 'brain_item', entityId: id, after: { version: r!.version }, meta });
      return this.itemDto(r!, approved ? auth.fullName : null, []);
    });
  }

  async versions(auth: TenantAuthContext, id: string) {
    return this.db.tenant(auth, async (tx) => {
      await this.loadItem(tx, auth.tenantId, id);
      const rows = await tx
        .select({ v: brainItemVersions, name: users.fullName })
        .from(brainItemVersions)
        .leftJoin(users, eq(users.id, brainItemVersions.changedBy))
        .where(and(eq(brainItemVersions.tenantId, auth.tenantId), eq(brainItemVersions.brainItemId, id)))
        .orderBy(desc(brainItemVersions.id));
      return rows.map(({ v, name }) => ({
        version: v.version, title: v.title, body: v.body, fields: v.fields, status: v.status, changedByName: name, changedAt: v.changedAt.toISOString(),
      }));
    });
  }

  // ---------------------------------------------------------------- documents

  async addDocument(auth: TenantAuthContext, input: { title: string; content: string; filename?: string | null }, meta: RequestMeta): Promise<BrainDocumentDto> {
    const flags = scanInjection(input.content);
    return this.db.tenant(auth, async (tx) => {
      const [d] = await tx
        .insert(brainDocuments)
        .values({
          tenantId: auth.tenantId, title: input.title, filename: input.filename ?? null, content: input.content,
          trustLevel: flags.length ? 'suspicious' : 'unverified', injectionFlags: flags, uploadedBy: auth.userId,
        })
        .returning();
      const parts = chunk(input.content);
      if (parts.length) {
        await tx.insert(brainChunks).values(parts.map((content, ordinal) => ({ tenantId: auth.tenantId, documentId: d!.id, ordinal, content, searchText: searchText(content) })));
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'brain.document.create', entityType: 'brain_document', entityId: d!.id,
        after: { title: d!.title, chunks: parts.length, flags }, meta,
      });
      return this.docDto(d!);
    });
  }

  async approveDocument(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<BrainDocumentDto> {
    return this.db.tenant(auth, async (tx) => {
      const [cur] = await tx.select().from(brainDocuments).where(and(eq(brainDocuments.tenantId, auth.tenantId), eq(brainDocuments.id, id)));
      if (!cur) throw notFound('Document');
      if (cur.trustLevel === 'suspicious') throw new AppError(409, 'DOCUMENT_SUSPICIOUS', 'This document contains instruction-like text and cannot be used by the assistant');
      if (cur.trustLevel === 'approved') throw new AppError(409, 'INVALID_STATE', 'Already approved');
      const [d] = await tx
        .update(brainDocuments)
        .set({ trustLevel: 'approved', approvedBy: auth.userId, approvedAt: new Date() })
        .where(and(eq(brainDocuments.tenantId, auth.tenantId), eq(brainDocuments.id, id)))
        .returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'brain.document.approve', entityType: 'brain_document', entityId: id, meta });
      return this.docDto(d!);
    });
  }

  async deleteDocument(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth, async (tx) => {
      const [d] = await tx.delete(brainDocuments).where(and(eq(brainDocuments.tenantId, auth.tenantId), eq(brainDocuments.id, id))).returning({ title: brainDocuments.title });
      if (!d) throw notFound('Document');
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'brain.document.delete', entityType: 'brain_document', entityId: id, before: d, meta });
    });
  }

  // ---------------------------------------------------------------- retrieval for agents

  /**
   * Approved knowledge relevant to `query`: matching approved items, the always-on rule sections,
   * and matching chunks from approved documents. Drafts and suspicious documents never reach a model.
   */
  async retrieve(tx: Tx, tenantId: string, query: string, opts: { sections?: BrainSection[]; limit?: number } = {}): Promise<BrainEntry[]> {
    const limit = opts.limit ?? 24;
    const q = tsQuery(query);
    const approved = and(eq(brainItems.tenantId, tenantId), eq(brainItems.status, 'approved'));
    const fixed = await tx
      .select()
      .from(brainItems)
      .where(and(approved, inArray(brainItems.section, [...ALWAYS_SECTIONS, ...(opts.sections ?? [])])))
      .limit(60);
    const matched = q
      ? await tx
          .select()
          .from(brainItems)
          .where(and(approved, sql`${brainItems.searchTsv} @@ to_tsquery('simple', ${q})`))
          .orderBy(sql`ts_rank(${brainItems.searchTsv}, to_tsquery('simple', ${q})) DESC`)
          .limit(limit)
      : [];
    const chunks = q
      ? await tx
          .select({ id: brainChunks.id, content: brainChunks.content, title: brainDocuments.title, docId: brainDocuments.id })
          .from(brainChunks)
          .innerJoin(brainDocuments, and(eq(brainDocuments.tenantId, brainChunks.tenantId), eq(brainDocuments.id, brainChunks.documentId)))
          .where(and(eq(brainChunks.tenantId, tenantId), eq(brainDocuments.trustLevel, 'approved'), sql`${brainChunks.searchTsv} @@ to_tsquery('simple', ${q})`))
          .orderBy(sql`ts_rank(${brainChunks.searchTsv}, to_tsquery('simple', ${q})) DESC`)
          .limit(6)
      : [];
    const seen = new Set<string>();
    const out: BrainEntry[] = [];
    for (const r of [...fixed, ...matched]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const f = Object.keys(r.fields).length ? `\n${JSON.stringify(r.fields)}` : '';
      out.push({ id: `brain:${r.id}`, section: r.section, title: r.title, text: `${r.body}${f}`.trim() });
    }
    for (const c of chunks) out.push({ id: `doc:${c.docId}:${c.id}`, section: 'document', title: c.title, text: c.content });
    return out;
  }

  async forbiddenPhrases(tx: Tx, tenantId: string): Promise<string[]> {
    const rows = await tx
      .select({ title: brainItems.title, fields: brainItems.fields })
      .from(brainItems)
      .where(and(eq(brainItems.tenantId, tenantId), eq(brainItems.section, 'forbidden'), ne(brainItems.status, 'archived')));
    return rows.map((r) => String((r.fields as { phrase?: string }).phrase ?? r.title));
  }
}
