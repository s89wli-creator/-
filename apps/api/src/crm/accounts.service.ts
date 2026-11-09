import { Injectable } from '@nestjs/common';
import {
  accounts, activities, contacts, memberships, notes, territories, tracks, users, type Tx,
} from '@rakan/db';
import {
  normalizeCompanyName, normalizeDomain, normalizePhone,
  type AccountDto, type AccountInput, type AccountQuery, type ActivityDto, type ContactDto, type ContactInput, type NoteDto, type Paged,
} from '@rakan/shared';
import { aliasedTable, and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, forbidden, notFound } from '../common/errors';
import { FieldCryptoService } from '../common/field-crypto.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from './activity.service';
import { loadDefs, validateCustomValues } from './custom-fields';
import { findDuplicate } from './duplicates';
import { assertCanRead, assertCanWrite, ScopeService, type RecordScope } from './scope';

type AccountRow = typeof accounts.$inferSelect;
const ownerUser = aliasedTable(users, 'owner_user');

export function toAccountDto(a: AccountRow, ownerName: string | null, openOpportunities?: number): AccountDto {
  return {
    id: a.id, name: a.name, legalName: a.legalName, crNumber: a.crNumber, vatNumber: a.vatNumber,
    websiteDomain: a.websiteDomain, phone: a.phone, industry: a.industry, sizeBand: a.sizeBand, region: a.region,
    city: a.city, address: a.address, lat: a.lat, lng: a.lng, trackId: a.trackId, territoryId: a.territoryId,
    ownerMembershipId: a.ownerMembershipId, ownerName, status: a.status, disqualifyReason: a.disqualifyReason,
    leadSource: a.leadSource, leadSourceDetail: a.leadSourceDetail, customFields: a.customFields,
    lastActivityAt: a.lastActivityAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(),
    ...(openOpportunities !== undefined ? { openOpportunities } : {}),
  };
}

/** Converts validated input into stored columns (normalized identifiers). */
export function accountColumns(input: Partial<AccountInput>) {
  const out: Partial<typeof accounts.$inferInsert> = {};
  const set = <K extends keyof typeof accounts.$inferInsert>(k: K, v: (typeof accounts.$inferInsert)[K]) => (out[k] = v);
  if (input.name !== undefined) {
    set('name', input.name);
    set('nameNormalized', normalizeCompanyName(input.name));
  }
  if (input.phone !== undefined) {
    const p = input.phone ? normalizePhone(input.phone) : null;
    if (input.phone && !p) throw badRequest('VALIDATION_ERROR', 'Invalid phone', [{ path: 'phone', message: 'Invalid phone', code: 'invalid_phone' }]);
    set('phone', p);
  }
  if (input.website !== undefined) {
    const d = input.website ? normalizeDomain(input.website) : null;
    if (input.website && !d) throw badRequest('VALIDATION_ERROR', 'Invalid website', [{ path: 'website', message: 'Invalid website', code: 'invalid_domain' }]);
    set('websiteDomain', d);
  }
  const passthrough = [
    'legalName', 'crNumber', 'vatNumber', 'industry', 'sizeBand', 'region', 'city', 'address', 'lat', 'lng', 'trackId',
    'territoryId', 'ownerMembershipId', 'status', 'disqualifyReason', 'leadSource', 'leadSourceDetail',
  ] as const;
  for (const k of passthrough) if (input[k] !== undefined) (out as Record<string, unknown>)[k] = input[k] ?? null;
  return out;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly activity: ActivityService,
    private readonly crypto: FieldCryptoService,
  ) {}

  /** Loads an account within tenant + scope. Throws 404 if missing or not visible. */
  async loadAccount(tx: Tx, auth: TenantAuthContext, scope: RecordScope, id: string, write = false): Promise<AccountRow> {
    const [a] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, id), isNull(accounts.deletedAt)))
      .limit(1);
    if (!a) throw notFound('Account');
    if (write) assertCanWrite(scope, a.ownerMembershipId);
    else assertCanRead(scope, a.ownerMembershipId);
    return a;
  }

  private listWhere(auth: TenantAuthContext, scope: RecordScope, q: Partial<AccountQuery>): SQL[] {
    const where: SQL[] = [eq(accounts.tenantId, auth.tenantId), isNull(accounts.deletedAt)];
    if (scope.restricted && !scope.readAll) where.push(eq(accounts.ownerMembershipId, scope.membershipId));
    if (q.trackId) where.push(eq(accounts.trackId, q.trackId));
    if (q.territoryId) where.push(eq(accounts.territoryId, q.territoryId));
    if (q.status) where.push(eq(accounts.status, q.status));
    if (q.city) where.push(sql`lower(${accounts.city}) = lower(${q.city})`);
    if (q.ownerMembershipId === 'unassigned') where.push(isNull(accounts.ownerMembershipId));
    else if (q.ownerMembershipId === 'me') where.push(eq(accounts.ownerMembershipId, auth.membershipId));
    else if (q.ownerMembershipId) where.push(eq(accounts.ownerMembershipId, q.ownerMembershipId));
    if (q.q) {
      const norm = normalizeCompanyName(q.q);
      const phone = normalizePhone(q.q);
      const conds: SQL[] = [
        ilike(accounts.nameNormalized, `%${norm.replace(/[%_\\]/g, (m) => '\\' + m)}%`),
        sql`similarity(${accounts.nameNormalized}, ${norm}) > 0.4`,
        eq(accounts.crNumber, q.q),
      ];
      if (phone) conds.push(eq(accounts.phone, phone));
      where.push(or(...conds)!);
    }
    return where;
  }

  list(auth: TenantAuthContext, q: AccountQuery): Promise<Paged<AccountDto>> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const where = and(...this.listWhere(auth, scope, q));
      const [{ total }] = (await tx.select({ total: count() }).from(accounts).where(where)) as [{ total: number }];
      const order =
        q.sort === 'name' ? [asc(accounts.name)] : q.sort === 'created_desc' ? [desc(accounts.createdAt)] : [sql`${accounts.lastActivityAt} DESC NULLS LAST`, desc(accounts.createdAt)];
      const openOpps = sql<number>`(SELECT count(*)::int FROM opportunities o JOIN pipeline_stages s ON s.id = o.stage_id
        WHERE o.tenant_id = ${accounts.tenantId} AND o.account_id = ${accounts.id} AND o.deleted_at IS NULL AND s.category = 'open')`;
      const rows = await tx
        .select({ a: accounts, ownerName: ownerUser.fullName, openOpps })
        .from(accounts)
        .leftJoin(memberships, and(eq(memberships.tenantId, accounts.tenantId), eq(memberships.id, accounts.ownerMembershipId)))
        .leftJoin(ownerUser, eq(ownerUser.id, memberships.userId))
        .where(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return { items: rows.map((r) => toAccountDto(r.a, r.ownerName, r.openOpps)), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Rows for export (same filters & scope as the list, capped). */
  exportRows(auth: TenantAuthContext, q: Partial<AccountQuery>, meta: RequestMeta) {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const rows = await tx
        .select({ a: accounts, ownerName: ownerUser.fullName, trackName: tracks.name })
        .from(accounts)
        .leftJoin(memberships, and(eq(memberships.tenantId, accounts.tenantId), eq(memberships.id, accounts.ownerMembershipId)))
        .leftJoin(ownerUser, eq(ownerUser.id, memberships.userId))
        .leftJoin(tracks, and(eq(tracks.tenantId, accounts.tenantId), eq(tracks.id, accounts.trackId)))
        .where(and(...this.listWhere(auth, scope, q)))
        .orderBy(asc(accounts.name))
        .limit(50_000);
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'account.export', entityType: 'account',
        after: { count: rows.length, filters: q }, meta,
      });
      return rows;
    });
  }

  get(auth: TenantAuthContext, id: string): Promise<AccountDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const a = await this.loadAccount(tx, auth, scope, id);
      return toAccountDto(a, await this.memberName(tx, auth.tenantId, a.ownerMembershipId));
    });
  }

  private async memberName(tx: Tx, tenantId: string, membershipId: string | null): Promise<string | null> {
    if (!membershipId) return null;
    const [r] = await tx
      .select({ name: users.fullName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
    return r?.name ?? null;
  }

  /** Validates that referenced track/territory/owner belong to this tenant (the composite FKs also enforce it). */
  private async checkRefs(tx: Tx, auth: TenantAuthContext, input: Partial<AccountInput>): Promise<void> {
    if (input.trackId) {
      const [t] = await tx.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, input.trackId)));
      if (!t) throw badRequest('INVALID_REFERENCE', 'Unknown track', [{ path: 'trackId', message: 'Unknown track', code: 'invalid_reference' }]);
    }
    if (input.territoryId) {
      const [t] = await tx.select({ id: territories.id }).from(territories).where(and(eq(territories.tenantId, auth.tenantId), eq(territories.id, input.territoryId)));
      if (!t) throw badRequest('INVALID_REFERENCE', 'Unknown territory', [{ path: 'territoryId', message: 'Unknown territory', code: 'invalid_reference' }]);
    }
    if (input.ownerMembershipId) {
      const [m] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, auth.tenantId), eq(memberships.id, input.ownerMembershipId), eq(memberships.status, 'active')));
      if (!m) throw badRequest('INVALID_REFERENCE', 'Unknown owner', [{ path: 'ownerMembershipId', message: 'Unknown member', code: 'invalid_reference' }]);
    }
  }

  create(auth: TenantAuthContext, input: AccountInput, force: boolean, meta: RequestMeta): Promise<AccountDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      if (scope.restricted) {
        // Reps create accounts assigned to themselves only.
        if (input.ownerMembershipId && input.ownerMembershipId !== auth.membershipId) throw forbidden('Reps can only create accounts assigned to themselves');
        input = { ...input, ownerMembershipId: auth.membershipId };
      }
      await this.checkRefs(tx, auth, input);
      const cols = accountColumns(input);
      if (!force) {
        const dup = await findDuplicate(tx, auth.tenantId, {
          name: input.name, nameNormalized: cols.nameNormalized!, crNumber: cols.crNumber, vatNumber: cols.vatNumber,
          websiteDomain: cols.websiteDomain, phone: cols.phone, city: cols.city,
        });
        if (dup) throw new AppError(409, 'DUPLICATE_ACCOUNT', 'A matching account already exists', dup);
      }
      const defs = await loadDefs(tx, auth.tenantId, 'account');
      const customFields = validateCustomValues(defs, input.customFields, {}, input.trackId ?? null);
      const [a] = await tx
        .insert(accounts)
        .values({ ...(cols as typeof accounts.$inferInsert), tenantId: auth.tenantId, customFields, createdBy: auth.userId, lastActivityAt: new Date() })
        .returning();
      await this.activity.record(tx, { tenantId: auth.tenantId, accountId: a!.id, type: 'account_created', actorUserId: auth.userId, summary: a!.name });
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'account.create', entityType: 'account', entityId: a!.id,
        after: { name: a!.name, crNumber: a!.crNumber, city: a!.city, ownerMembershipId: a!.ownerMembershipId, forcedDespiteDuplicate: force || undefined }, meta,
      });
      return toAccountDto(a!, await this.memberName(tx, auth.tenantId, a!.ownerMembershipId));
    });
  }

  update(auth: TenantAuthContext, id: string, input: Partial<AccountInput>, meta: RequestMeta): Promise<AccountDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const before = await this.loadAccount(tx, auth, scope, id, true);
      if (scope.restricted && input.ownerMembershipId !== undefined && input.ownerMembershipId !== before.ownerMembershipId) {
        throw forbidden('Reps cannot reassign accounts');
      }
      await this.checkRefs(tx, auth, input);
      const cols = accountColumns(input);
      const strongChange = ['crNumber', 'vatNumber', 'websiteDomain', 'phone'].some(
        (k) => (cols as Record<string, unknown>)[k] && (cols as Record<string, unknown>)[k] !== (before as Record<string, unknown>)[k],
      );
      if (strongChange) {
        const dup = await findDuplicate(
          tx, auth.tenantId,
          { name: before.name, nameNormalized: '\u0000', crNumber: cols.crNumber, vatNumber: cols.vatNumber, websiteDomain: cols.websiteDomain, phone: cols.phone, city: '\u0000' },
          id,
        );
        if (dup) throw new AppError(409, 'DUPLICATE_ACCOUNT', 'Another account already uses this identifier', dup);
      }
      const defs = input.customFields ? await loadDefs(tx, auth.tenantId, 'account') : [];
      const customFields = input.customFields
        ? validateCustomValues(defs, input.customFields, before.customFields, (cols.trackId as string | null | undefined) ?? before.trackId)
        : undefined;
      const [after] = await tx
        .update(accounts)
        .set({ ...cols, ...(customFields ? { customFields } : {}), updatedAt: new Date() })
        .where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, id)))
        .returning();
      const changed = Object.keys(cols).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
      if (customFields) changed.push('customFields');
      if (changed.length) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'account.update', entityType: 'account', entityId: id,
          before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
          after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
          meta,
        });
        if (changed.includes('ownerMembershipId')) {
          await this.activity.record(tx, {
            tenantId: auth.tenantId, accountId: id, type: 'account_assigned', actorUserId: auth.userId,
            summary: await this.memberName(tx, auth.tenantId, after!.ownerMembershipId),
          });
        }
      }
      return toAccountDto(after!, await this.memberName(tx, auth.tenantId, after!.ownerMembershipId));
    });
  }

  remove(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const a = await this.loadAccount(tx, auth, scope, id, true);
      // Soft delete: recoverable, and keeps history/audit intact.
      await tx.update(accounts).set({ deletedAt: new Date() }).where(and(eq(accounts.tenantId, auth.tenantId), eq(accounts.id, id)));
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'account.delete', entityType: 'account', entityId: id,
        before: { name: a.name, crNumber: a.crNumber }, meta,
      });
    });
  }

  // ---------------- contacts ----------------

  private contactDto(tenantId: string, c: typeof contacts.$inferSelect): ContactDto {
    return {
      id: c.id, accountId: c.accountId, fullName: c.fullName, jobTitle: c.jobTitle,
      phone: this.crypto.decrypt(tenantId, c.phoneEnc), email: this.crypto.decrypt(tenantId, c.emailEnc),
      preferredChannel: c.preferredChannel, isPrimary: c.isPrimary, doNotContact: c.doNotContact, dncReason: c.dncReason,
      dncAt: c.dncAt?.toISOString() ?? null, customFields: c.customFields, createdAt: c.createdAt.toISOString(),
    };
  }

  contactColumns(tenantId: string, input: Partial<ContactInput>) {
    const out: Partial<typeof contacts.$inferInsert> = {};
    if (input.fullName !== undefined) out.fullName = input.fullName;
    if (input.jobTitle !== undefined) out.jobTitle = input.jobTitle ?? null;
    if (input.preferredChannel !== undefined) out.preferredChannel = input.preferredChannel ?? null;
    if (input.isPrimary !== undefined) out.isPrimary = input.isPrimary;
    if (input.phone !== undefined) {
      const p = input.phone ? normalizePhone(input.phone) : null;
      if (input.phone && !p) throw badRequest('VALIDATION_ERROR', 'Invalid phone', [{ path: 'phone', message: 'Invalid phone', code: 'invalid_phone' }]);
      out.phoneEnc = this.crypto.encrypt(tenantId, p);
      out.phoneHash = this.crypto.hash(tenantId, p);
    }
    if (input.email !== undefined) {
      const e = input.email?.toLowerCase() ?? null;
      out.emailEnc = this.crypto.encrypt(tenantId, e);
      out.emailHash = this.crypto.hash(tenantId, e);
    }
    return out;
  }

  listContacts(auth: TenantAuthContext, accountId: string): Promise<ContactDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.loadAccount(tx, auth, scope, accountId);
      const rows = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.accountId, accountId), isNull(contacts.deletedAt)))
        .orderBy(desc(contacts.isPrimary), asc(contacts.fullName));
      return rows.map((c) => this.contactDto(auth.tenantId, c));
    });
  }

  private async clearPrimary(tx: Tx, tenantId: string, accountId: string, exceptId?: string) {
    await tx
      .update(contacts)
      .set({ isPrimary: false })
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.accountId, accountId), exceptId ? sql`${contacts.id} <> ${exceptId}` : sql`true`));
  }

  createContact(auth: TenantAuthContext, accountId: string, input: ContactInput, meta: RequestMeta): Promise<ContactDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.loadAccount(tx, auth, scope, accountId, true);
      const defs = await loadDefs(tx, auth.tenantId, 'contact');
      const customFields = validateCustomValues(defs, input.customFields);
      if (input.isPrimary) await this.clearPrimary(tx, auth.tenantId, accountId);
      const [c] = await tx
        .insert(contacts)
        .values({ ...(this.contactColumns(auth.tenantId, input) as typeof contacts.$inferInsert), tenantId: auth.tenantId, accountId, customFields })
        .returning();
      await this.activity.record(tx, { tenantId: auth.tenantId, accountId, type: 'contact_added', actorUserId: auth.userId, refType: 'contact', refId: c!.id, summary: c!.fullName });
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'contact.create', entityType: 'contact', entityId: c!.id,
        after: { accountId, fullName: c!.fullName, jobTitle: c!.jobTitle }, meta, // personal data is not copied into the audit log
      });
      return this.contactDto(auth.tenantId, c!);
    });
  }

  private async loadContact(tx: Tx, auth: TenantAuthContext, scope: RecordScope, id: string, write: boolean) {
    const [c] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, id), isNull(contacts.deletedAt)))
      .limit(1);
    if (!c) throw notFound('Contact');
    await this.loadAccount(tx, auth, scope, c.accountId, write);
    return c;
  }

  updateContact(auth: TenantAuthContext, id: string, input: Partial<ContactInput>, meta: RequestMeta): Promise<ContactDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const before = await this.loadContact(tx, auth, scope, id, true);
      const defs = input.customFields ? await loadDefs(tx, auth.tenantId, 'contact') : [];
      const customFields = input.customFields ? validateCustomValues(defs, input.customFields, before.customFields) : undefined;
      if (input.isPrimary) await this.clearPrimary(tx, auth.tenantId, before.accountId, id);
      const [c] = await tx
        .update(contacts)
        .set({ ...this.contactColumns(auth.tenantId, input), ...(customFields ? { customFields } : {}), updatedAt: new Date() })
        .where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, id)))
        .returning();
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'contact.update', entityType: 'contact', entityId: id,
        after: { fields: Object.keys(input) }, meta,
      });
      return this.contactDto(auth.tenantId, c!);
    });
  }

  /** Do-not-contact: recorded with time and reason; blocks outbound messaging in later phases. */
  setDnc(auth: TenantAuthContext, id: string, input: { doNotContact: boolean; reason?: string | null }, meta: RequestMeta): Promise<ContactDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const before = await this.loadContact(tx, auth, scope, id, true);
      const [c] = await tx
        .update(contacts)
        .set({ doNotContact: input.doNotContact, dncReason: input.doNotContact ? input.reason ?? null : null, dncAt: input.doNotContact ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, id)))
        .returning();
      await this.activity.record(tx, {
        tenantId: auth.tenantId, accountId: before.accountId, type: input.doNotContact ? 'contact_dnc_on' : 'contact_dnc_off',
        actorUserId: auth.userId, refType: 'contact', refId: id, summary: before.fullName,
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'contact.dnc', entityType: 'contact', entityId: id,
        before: { doNotContact: before.doNotContact }, after: { doNotContact: input.doNotContact, reason: input.reason ?? null }, meta,
      });
      return this.contactDto(auth.tenantId, c!);
    });
  }

  removeContact(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      const c = await this.loadContact(tx, auth, scope, id, true);
      // Personal data is erased (not just hidden) when a contact is deleted.
      await tx
        .update(contacts)
        .set({ deletedAt: new Date(), phoneEnc: null, phoneHash: null, emailEnc: null, emailHash: null, fullName: '—' })
        .where(and(eq(contacts.tenantId, auth.tenantId), eq(contacts.id, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'contact.delete', entityType: 'contact', entityId: id, before: { accountId: c.accountId }, meta });
    });
  }

  // ---------------- notes & timeline ----------------

  listNotes(auth: TenantAuthContext, accountId: string): Promise<NoteDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.loadAccount(tx, auth, scope, accountId);
      const rows = await tx
        .select({ n: notes, authorName: users.fullName })
        .from(notes)
        .innerJoin(users, eq(users.id, notes.authorUserId))
        .where(and(eq(notes.tenantId, auth.tenantId), eq(notes.accountId, accountId), isNull(notes.deletedAt)))
        .orderBy(desc(notes.createdAt));
      return rows.map(({ n, authorName }) => ({ id: n.id, body: n.body, authorName, authorUserId: n.authorUserId, createdAt: n.createdAt.toISOString() }));
    });
  }

  createNote(auth: TenantAuthContext, accountId: string, body: string, meta: RequestMeta): Promise<NoteDto> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.loadAccount(tx, auth, scope, accountId, true);
      const [n] = await tx.insert(notes).values({ tenantId: auth.tenantId, accountId, body, authorUserId: auth.userId }).returning();
      await this.activity.record(tx, { tenantId: auth.tenantId, accountId, type: 'note_added', actorUserId: auth.userId, refType: 'note', refId: n!.id, summary: body });
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'note.create', entityType: 'note', entityId: n!.id, after: { accountId }, meta });
      return { id: n!.id, body: n!.body, authorName: auth.fullName, authorUserId: auth.userId, createdAt: n!.createdAt.toISOString() };
    });
  }

  removeNote(auth: TenantAuthContext, id: string, meta: RequestMeta): Promise<void> {
    return this.db.tenant(auth, async (tx) => {
      const [n] = await tx.select().from(notes).where(and(eq(notes.tenantId, auth.tenantId), eq(notes.id, id), isNull(notes.deletedAt)));
      if (!n) throw notFound('Note');
      const scope = await this.scopes.forRequest(tx, auth);
      await this.loadAccount(tx, auth, scope, n.accountId);
      // Authors delete their own notes; owners/managers can delete any.
      if (n.authorUserId !== auth.userId && !(auth.role === 'owner' || auth.role === 'manager')) throw forbidden('You can only delete your own notes');
      await tx.update(notes).set({ deletedAt: new Date() }).where(and(eq(notes.tenantId, auth.tenantId), eq(notes.id, id)));
      await this.audit.record(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'note.delete', entityType: 'note', entityId: id, before: { body: n.body }, meta });
    });
  }

  timeline(auth: TenantAuthContext, accountId: string): Promise<ActivityDto[]> {
    return this.db.tenant(auth, async (tx) => {
      const scope = await this.scopes.forRequest(tx, auth);
      await this.loadAccount(tx, auth, scope, accountId);
      const rows = await tx
        .select({ a: activities, actorName: users.fullName })
        .from(activities)
        .leftJoin(users, eq(users.id, activities.actorUserId))
        .where(and(eq(activities.tenantId, auth.tenantId), eq(activities.accountId, accountId)))
        .orderBy(desc(activities.id))
        .limit(200);
      return rows.map(({ a, actorName }) => ({
        id: a.id, type: a.type, actorType: a.actorType, actorName, summary: a.summary, refType: a.refType, refId: a.refId,
        opportunityId: a.opportunityId, occurredAt: a.occurredAt.toISOString(),
      }));
    });
  }
}

