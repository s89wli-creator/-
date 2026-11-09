import { Inject, Injectable } from '@nestjs/common';
import {
  accounts, contacts, customFieldDefs, importJobs, importRows, memberships, notes, tracks, type Tx,
} from '@rakan/db';
import {
  ACCOUNT_IMPORT_FIELDS, normalizeArabic, normalizeCompanyName, normalizeCr, normalizeDomain, normalizePhone, normalizeVat,
  type ImportJobDto, type ImportMappingInput, type ImportRowDto,
} from '@rakan/shared';
import { and, asc, count, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { FieldCryptoService } from '../common/field-crypto.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from './activity.service';
import { validateCustomValues } from './custom-fields';
import { findDuplicate } from './duplicates';
import { parseSpreadsheet } from './spreadsheet';

/** Header synonyms (compared after Arabic normalization) for automatic column mapping. */
const SYNONYMS: Record<string, string[]> = {
  name: ['اسم الشركة', 'الشركة', 'اسم العميل', 'العميل', 'الاسم', 'اسم المنشأة', 'المنشأة', 'company', 'company name', 'name', 'account', 'customer'],
  legalName: ['الاسم القانوني', 'الاسم التجاري', 'legal name'],
  crNumber: ['السجل التجاري', 'رقم السجل', 'رقم السجل التجاري', 'سجل تجاري', 'cr', 'cr number', 'commercial registration'],
  vatNumber: ['الرقم الضريبي', 'رقم ضريبي', 'vat', 'vat number', 'tax number'],
  website: ['الموقع', 'الموقع الإلكتروني', 'website', 'web', 'url'],
  phone: ['هاتف الشركة', 'الهاتف', 'رقم الهاتف', 'phone', 'telephone', 'tel'],
  industry: ['النشاط', 'القطاع', 'نوع النشاط', 'industry', 'sector', 'activity'],
  region: ['المنطقة', 'region', 'province'],
  city: ['المدينة', 'city'],
  address: ['العنوان', 'الحي', 'address'],
  lat: ['خط العرض', 'lat', 'latitude'],
  lng: ['خط الطول', 'lng', 'long', 'longitude'],
  track: ['المسار', 'نوع العميل', 'الشريحة', 'track', 'segment'],
  'contact.fullName': ['اسم المسؤول', 'المسؤول', 'جهة الاتصال', 'اسم جهة الاتصال', 'contact', 'contact name', 'contact person'],
  'contact.jobTitle': ['المسمى الوظيفي', 'الوظيفة', 'المنصب', 'job title', 'title', 'position'],
  'contact.phone': ['جوال المسؤول', 'هاتف المسؤول', 'رقم المسؤول', 'الجوال', 'contact phone', 'mobile'],
  'contact.email': ['البريد', 'البريد الإلكتروني', 'الإيميل', 'email', 'e-mail'],
  note: ['ملاحظات', 'ملاحظة', 'notes', 'note', 'comments'],
};

export function suggestMapping(headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const [field, words] of Object.entries(SYNONYMS)) {
    const targets = new Set(words.map(normalizeArabic));
    const h = headers.find((x) => !used.has(x) && targets.has(normalizeArabic(x)));
    if (h) {
      out[field] = h;
      used.add(h);
    }
  }
  return out;
}

interface Normalized {
  name?: string; nameNormalized?: string; legalName?: string; crNumber?: string; vatNumber?: string; websiteDomain?: string;
  phone?: string; industry?: string; region?: string; city?: string; address?: string; lat?: number; lng?: number; trackId?: string;
  contact?: { fullName?: string; jobTitle?: string; phone?: string; email?: string };
  note?: string; customFields?: Record<string, unknown>;
}
type RowError = { field: string; code: string; blocking?: boolean };

const jobDto = (j: typeof importJobs.$inferSelect): ImportJobDto => ({
  id: j.id, entity: j.entity, filename: j.filename, status: j.status, headers: j.headers, suggestedMapping: suggestMapping(j.headers),
  mapping: j.mapping, stats: j.stats, createdAt: j.createdAt.toISOString(), completedAt: j.completedAt?.toISOString() ?? null,
});

@Injectable()
export class ImportsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly crypto: FieldCryptoService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async upload(auth: TenantAuthContext, file: { originalname: string; buffer: Buffer }, meta: RequestMeta): Promise<ImportJobDto> {
    const sheet = await parseSpreadsheet(file.buffer, file.originalname, this.config.IMPORT_MAX_ROWS);
    return this.db.tenant(auth, async (tx) => {
      const [job] = await tx
        .insert(importJobs)
        .values({ tenantId: auth.tenantId, filename: file.originalname.slice(0, 200), headers: sheet.headers, createdBy: auth.userId, stats: { rows: sheet.rows.length } })
        .returning();
      for (let i = 0; i < sheet.rows.length; i += 500) {
        await tx.insert(importRows).values(
          sheet.rows.slice(i, i + 500).map((raw, k) => ({ tenantId: auth.tenantId, importJobId: job!.id, rowNumber: i + k + 1, raw })),
        );
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'import.upload', entityType: 'import', entityId: job!.id,
        after: { filename: job!.filename, rows: sheet.rows.length }, meta,
      });
      return jobDto(job!);
    });
  }

  private async loadJob(tx: Tx, auth: TenantAuthContext, id: string) {
    const [j] = await tx.select().from(importJobs).where(and(eq(importJobs.tenantId, auth.tenantId), eq(importJobs.id, id)));
    if (!j) throw notFound('Import');
    return j;
  }

  get(auth: TenantAuthContext, id: string): Promise<ImportJobDto> {
    return this.db.tenant(auth, async (tx) => jobDto(await this.loadJob(tx, auth, id)));
  }

  /** Applies the column mapping: validates, normalizes and detects duplicates for every row. Re-runnable while in review. */
  setMapping(auth: TenantAuthContext, id: string, input: ImportMappingInput, meta: RequestMeta): Promise<ImportJobDto> {
    return this.db.tenant(auth, async (tx) => {
      const job = await this.loadJob(tx, auth, id);
      if (job.status !== 'uploaded' && job.status !== 'review') throw new AppError(409, 'INVALID_STATE', 'Import already finished');
      const defs = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.tenantId, auth.tenantId), eq(customFieldDefs.entity, 'account')));
      const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, h]) => h));
      const bad = Object.entries(mapping).filter(
        ([field, header]) =>
          !job.headers.includes(header) ||
          !((ACCOUNT_IMPORT_FIELDS as readonly string[]).includes(field) || (field.startsWith('custom.') && defs.some((d) => `custom.${d.key}` === field))),
      );
      if (bad.length) throw badRequest('INVALID_MAPPING', 'Unknown field or column', bad.map(([f]) => ({ path: f, message: 'invalid', code: 'invalid_mapping' })));
      if (!mapping.name) throw badRequest('INVALID_MAPPING', 'The company name column is required', [{ path: 'name', message: 'required', code: 'required' }]);
      const trackRows = await tx.select().from(tracks).where(eq(tracks.tenantId, auth.tenantId));
      if (input.defaults.trackId && !trackRows.some((t) => t.id === input.defaults.trackId)) throw badRequest('INVALID_REFERENCE', 'Unknown track');
      if (input.defaults.ownerMembershipId) {
        const [m] = await tx.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, input.defaults.ownerMembershipId), eq(memberships.status, 'active')));
        if (!m) throw badRequest('INVALID_REFERENCE', 'Unknown owner');
      }

      const rows = await tx.select().from(importRows).where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.importJobId, id))).orderBy(asc(importRows.rowNumber));
      const seen = new Map<string, number>(); // in-file duplicate keys -> first row number
      const stats = { rows: rows.length, valid: 0, invalid: 0, duplicates: 0, warnings: 0 };
      for (const row of rows) {
        const get = (f: string) => (mapping[f] ? (row.raw[mapping[f]] ?? '').trim() : '');
        const n: Normalized = {};
        const errors: RowError[] = [];
        const name = get('name');
        if (name.length < 2) errors.push({ field: 'name', code: name ? 'too_short' : 'required', blocking: true });
        else {
          n.name = name.slice(0, 200);
          n.nameNormalized = normalizeCompanyName(n.name);
        }
        const opt = (field: string, value: string, norm: (v: string) => string | null, key: keyof Normalized) => {
          if (!value) return;
          const v = norm(value);
          if (v) (n as Record<string, unknown>)[key] = v;
          else errors.push({ field, code: 'invalid' });
        };
        opt('crNumber', get('crNumber'), normalizeCr, 'crNumber');
        opt('vatNumber', get('vatNumber'), normalizeVat, 'vatNumber');
        opt('website', get('website'), normalizeDomain, 'websiteDomain');
        opt('phone', get('phone'), normalizePhone, 'phone');
        for (const f of ['legalName', 'industry', 'region', 'city', 'address'] as const) if (get(f)) n[f] = get(f).slice(0, 300);
        for (const f of ['lat', 'lng'] as const) {
          const raw = get(f);
          if (!raw) continue;
          const v = Number(raw);
          if (Number.isFinite(v) && Math.abs(v) <= (f === 'lat' ? 90 : 180)) n[f] = v;
          else errors.push({ field: f, code: 'invalid' });
        }
        const trackVal = get('track');
        if (trackVal) {
          const t = trackRows.find((x) => x.key === trackVal.toLowerCase() || normalizeArabic(x.name) === normalizeArabic(trackVal));
          if (t) n.trackId = t.id;
          else errors.push({ field: 'track', code: 'unknown_track' });
        }
        n.trackId ??= input.defaults.trackId ?? undefined;
        const contactName = get('contact.fullName');
        if (contactName) {
          n.contact = { fullName: contactName.slice(0, 120), jobTitle: get('contact.jobTitle') || undefined };
          if (get('contact.phone')) {
            const p = normalizePhone(get('contact.phone'));
            if (p) n.contact.phone = p;
            else errors.push({ field: 'contact.phone', code: 'invalid' });
          }
          if (get('contact.email')) {
            const e = get('contact.email').toLowerCase();
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) n.contact.email = e;
            else errors.push({ field: 'contact.email', code: 'invalid' });
          }
        } else if (get('contact.phone') || get('contact.email')) {
          errors.push({ field: 'contact.fullName', code: 'required' });
        }
        if (get('note')) n.note = get('note').slice(0, 5000);
        const custom: Record<string, unknown> = {};
        for (const [field, header] of Object.entries(mapping)) {
          if (!field.startsWith('custom.') || !row.raw[header]) continue;
          const key = field.slice(7);
          try {
            Object.assign(custom, validateCustomValues(defs, { [key]: row.raw[header] }, {}, n.trackId ?? null));
          } catch {
            errors.push({ field, code: 'invalid' });
          }
        }
        if (Object.keys(custom).length) n.customFields = custom;

        const blocking = errors.some((e) => e.blocking);
        let duplicateOf: string | null = null;
        let duplicateReason: string | null = null;
        let inFileDuplicateOf: number | null = null;
        if (!blocking) {
          const keys = [
            n.crNumber && `cr:${n.crNumber}`, n.vatNumber && `vat:${n.vatNumber}`, n.websiteDomain && `web:${n.websiteDomain}`,
            n.phone && `tel:${n.phone}`, `name:${n.nameNormalized}|${normalizeArabic(n.city ?? '')}`,
          ].filter(Boolean) as string[];
          const prior = keys.map((k) => seen.get(k)).find((v) => v !== undefined);
          if (prior !== undefined) inFileDuplicateOf = prior;
          for (const k of keys) if (!seen.has(k)) seen.set(k, row.rowNumber);
          const dup = await findDuplicate(tx, auth.tenantId, {
            name: n.name!, nameNormalized: n.nameNormalized!, crNumber: n.crNumber, vatNumber: n.vatNumber, websiteDomain: n.websiteDomain, phone: n.phone, city: n.city,
          });
          if (dup) {
            duplicateOf = dup.id;
            duplicateReason = dup.reason;
          }
        }
        const isDup = !!duplicateOf || inFileDuplicateOf !== null;
        stats.valid += blocking ? 0 : 1;
        stats.invalid += blocking ? 1 : 0;
        stats.duplicates += isDup ? 1 : 0;
        stats.warnings += errors.some((e) => !e.blocking) ? 1 : 0;
        await tx
          .update(importRows)
          .set({
            normalized: blocking ? null : (n as Record<string, unknown>), errors: errors.length ? errors.map(({ field, code, blocking: b }) => ({ field, code: b ? code : `warning:${code}` })) : null,
            duplicateOf, duplicateReason, inFileDuplicateOf,
            // Safe default: never create a probable duplicate silently.
            resolution: blocking ? null : isDup ? 'skip' : 'create',
          })
          .where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.id, row.id)));
      }
      const [updated] = await tx
        .update(importJobs)
        .set({ mapping, defaults: input.defaults, dataPermissionConfirmed: true, status: 'review', stats })
        .where(and(eq(importJobs.tenantId, auth.tenantId), eq(importJobs.id, id)))
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'import.map', entityType: 'import', entityId: id,
        after: { mapping, dataPermissionConfirmed: true, stats }, meta,
      });
      return jobDto(updated!);
    });
  }

  rows(auth: TenantAuthContext, id: string, q: { filter: 'all' | 'duplicates' | 'invalid' | 'warnings' | 'create'; page: number }): Promise<{ items: ImportRowDto[]; total: number }> {
    return this.db.tenant(auth, async (tx) => {
      await this.loadJob(tx, auth, id);
      const where: SQL[] = [eq(importRows.tenantId, auth.tenantId), eq(importRows.importJobId, id)];
      if (q.filter === 'duplicates') where.push(sql`(${importRows.duplicateOf} IS NOT NULL OR ${importRows.inFileDuplicateOf} IS NOT NULL)`);
      if (q.filter === 'invalid') where.push(isNull(importRows.normalized));
      if (q.filter === 'warnings') where.push(isNotNull(importRows.normalized), isNotNull(importRows.errors));
      if (q.filter === 'create') where.push(eq(importRows.resolution, 'create'));
      const [{ total }] = (await tx.select({ total: count() }).from(importRows).where(and(...where))) as [{ total: number }];
      const rows = await tx
        .select({ r: importRows, dupName: accounts.name })
        .from(importRows)
        .leftJoin(accounts, and(eq(accounts.tenantId, importRows.tenantId), eq(accounts.id, importRows.duplicateOf)))
        .where(and(...where))
        .orderBy(asc(importRows.rowNumber))
        .limit(50)
        .offset((q.page - 1) * 50);
      return {
        total,
        items: rows.map(({ r, dupName }) => ({
          id: r.id, rowNumber: r.rowNumber, raw: r.raw, normalized: r.normalized, errors: r.errors, duplicateOfId: r.duplicateOf,
          duplicateOfName: dupName ?? (r.inFileDuplicateOf !== null ? `#${r.inFileDuplicateOf}` : null),
          duplicateReason: r.duplicateReason ?? (r.inFileDuplicateOf !== null ? 'in_file' : null), resolution: r.resolution, resultEntityId: r.resultEntityId,
        })),
      };
    });
  }

  setResolution(auth: TenantAuthContext, id: string, rowId: number, resolution: 'create' | 'merge' | 'skip'): Promise<{ ok: true }> {
    return this.db.tenant(auth, async (tx) => {
      const job = await this.loadJob(tx, auth, id);
      if (job.status !== 'review') throw new AppError(409, 'INVALID_STATE', 'Import is not in review');
      const [r] = await tx.select().from(importRows).where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.importJobId, id), eq(importRows.id, rowId)));
      if (!r) throw notFound('Row');
      if (!r.normalized) throw badRequest('INVALID_ROW', 'Invalid rows cannot be imported');
      if (resolution === 'merge' && !r.duplicateOf) throw badRequest('INVALID_RESOLUTION', 'Only rows matching an existing account can be merged');
      await tx.update(importRows).set({ resolution }).where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.id, rowId)));
      return { ok: true as const };
    });
  }

  /** Executes the import atomically (all rows or nothing). Merge only fills empty fields — never overwrites. */
  execute(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<ImportJobDto> {
    return this.db.tenant(auth, async (tx) => {
      const job = await this.loadJob(tx, auth, id);
      if (job.status !== 'review') throw new AppError(409, 'INVALID_STATE', 'Import is not ready');
      if (!job.dataPermissionConfirmed) throw badRequest('PERMISSION_NOT_CONFIRMED', 'Data permission not confirmed');
      const rows = await tx
        .select()
        .from(importRows)
        .where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.importJobId, id), inArray(importRows.resolution, ['create', 'merge'])))
        .orderBy(asc(importRows.rowNumber));
      const owner = job.defaults?.ownerMembershipId ?? null;
      let created = 0;
      let merged = 0;
      for (const r of rows) {
        const n = r.normalized as Normalized;
        let accountId: string;
        if (r.resolution === 'merge' && r.duplicateOf) {
          const [existing] = await tx.select().from(accounts).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, r.duplicateOf), isNull(accounts.deletedAt)));
          if (!existing) continue;
          const fill: Partial<typeof accounts.$inferInsert> = {};
          const pairs: [keyof Normalized, keyof typeof existing][] = [
            ['legalName', 'legalName'], ['crNumber', 'crNumber'], ['vatNumber', 'vatNumber'], ['websiteDomain', 'websiteDomain'], ['phone', 'phone'],
            ['industry', 'industry'], ['region', 'region'], ['city', 'city'], ['address', 'address'], ['lat', 'lat'], ['lng', 'lng'], ['trackId', 'trackId'],
          ];
          for (const [src, dst] of pairs) if (n[src] !== undefined && (existing[dst] === null || existing[dst] === undefined)) (fill as Record<string, unknown>)[dst] = n[src];
          if (n.customFields) fill.customFields = { ...n.customFields, ...existing.customFields };
          if (Object.keys(fill).length) await tx.update(accounts).set({ ...fill, updatedAt: new Date() }).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, existing.id)));
          accountId = existing.id;
          merged++;
          await this.activity.record(tx, { tenantId: auth.tenantId, accountId, type: 'account_merged_from_import', actorUserId: auth.userId, refType: 'import', refId: id, summary: job.filename });
        } else {
          const [a] = await tx
            .insert(accounts)
            .values({
              tenantId: auth.tenantId, name: n.name!, nameNormalized: n.nameNormalized!, legalName: n.legalName ?? null, crNumber: n.crNumber ?? null,
              vatNumber: n.vatNumber ?? null, websiteDomain: n.websiteDomain ?? null, phone: n.phone ?? null, industry: n.industry ?? null,
              region: n.region ?? null, city: n.city ?? null, address: n.address ?? null, lat: n.lat ?? null, lng: n.lng ?? null, trackId: n.trackId ?? null,
              ownerMembershipId: owner, leadSource: 'import', leadSourceDetail: job.defaults?.leadSourceDetail ?? job.filename,
              customFields: n.customFields ?? {}, importJobId: id, createdBy: auth.userId, lastActivityAt: new Date(),
            })
            .returning({ id: accounts.id });
          accountId = a!.id;
          created++;
          await this.activity.record(tx, { tenantId: auth.tenantId, accountId, type: 'account_imported', actorUserId: auth.userId, refType: 'import', refId: id, summary: job.filename });
        }
        if (n.contact?.fullName) {
          const phoneHash = this.crypto.hash(auth.tenantId, n.contact.phone ?? null);
          const exists = phoneHash
            ? (await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.accountId, accountId), eq(contacts.phoneHash, phoneHash)))).length > 0
            : false;
          if (!exists) {
            const [{ n: existingContacts }] = (await tx.select({ n: count() }).from(contacts).where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.accountId, accountId)))) as [{ n: number }];
            await tx.insert(contacts).values({
              tenantId: auth.tenantId, accountId, fullName: n.contact.fullName, jobTitle: n.contact.jobTitle ?? null,
              phoneEnc: this.crypto.encrypt(auth.tenantId, n.contact.phone ?? null), phoneHash,
              emailEnc: this.crypto.encrypt(auth.tenantId, n.contact.email ?? null), emailHash: this.crypto.hash(auth.tenantId, n.contact.email ?? null),
              isPrimary: existingContacts === 0,
            });
          }
        }
        if (n.note) await tx.insert(notes).values({ tenantId: auth.tenantId, accountId, body: n.note, authorUserId: auth.userId });
        await tx.update(importRows).set({ resultEntityId: accountId }).where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.id, r.id)));
      }
      const stats = { ...job.stats, created, merged, skipped: (job.stats.rows ?? 0) - created - merged };
      const [done] = await tx
        .update(importJobs)
        .set({ status: 'completed', stats, completedAt: new Date() })
        .where(and(eq(importJobs.tenantId, auth.tenantId), eq(importJobs.id, id)))
        .returning();
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'import.execute', entityType: 'import', entityId: id, after: stats, meta });
      return jobDto(done!);
    });
  }

  cancel(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<ImportJobDto> {
    return this.db.tenant(auth, async (tx) => {
      const job = await this.loadJob(tx, auth, id);
      if (job.status === 'completed') throw new AppError(409, 'INVALID_STATE', 'Import already completed');
      const [j] = await tx.update(importJobs).set({ status: 'cancelled' }).where(and(eq(importJobs.tenantId, auth.tenantId), eq(importJobs.id, id))).returning();
      // Raw rows may contain personal data: remove them once the import is abandoned.
      await tx.delete(importRows).where(and(eq(importRows.tenantId, auth.tenantId), eq(importRows.importJobId, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'import.cancel', entityType: 'import', entityId: id, meta });
      return jobDto(j!);
    });
  }
}
