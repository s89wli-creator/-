import { accounts, type Tx } from '@rakan/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export interface DuplicateCandidate {
  name: string;
  nameNormalized: string;
  crNumber?: string | null;
  vatNumber?: string | null;
  websiteDomain?: string | null;
  phone?: string | null;
  city?: string | null;
}

export type DuplicateReason = 'cr_number' | 'vat_number' | 'website_domain' | 'phone' | 'name_city';
export interface DuplicateMatch { id: string; name: string; reason: DuplicateReason }

/** Similarity threshold for "same name in same city" (pg_trgm). */
export const NAME_SIMILARITY = 0.85;

/**
 * Finds an existing account that is very likely the same company.
 * Strongest signals first: CR, VAT, website domain, company phone, then normalized name + city.
 */
export async function findDuplicate(
  tx: Tx,
  tenantId: string,
  c: DuplicateCandidate,
  excludeId?: string,
): Promise<DuplicateMatch | null> {
  const base = [eq(accounts.tenantId, tenantId), isNull(accounts.deletedAt)];
  if (excludeId) base.push(sql`${accounts.id} <> ${excludeId}`);
  const exact: [DuplicateReason, AnyPgColumn, string | null | undefined][] = [
    ['cr_number', accounts.crNumber, c.crNumber],
    ['vat_number', accounts.vatNumber, c.vatNumber],
    ['website_domain', accounts.websiteDomain, c.websiteDomain],
    ['phone', accounts.phone, c.phone],
  ];
  for (const [reason, col, value] of exact) {
    if (!value) continue;
    const [m] = await tx.select({ id: accounts.id, name: accounts.name }).from(accounts).where(and(...base, eq(col, value))).limit(1);
    if (m) return { ...m, reason };
  }
  const cityCond = c.city ? sql`lower(${accounts.city}) = lower(${c.city})` : sql`${accounts.city} IS NULL`;
  const [m] = await tx
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(...base, cityCond, sql`similarity(${accounts.nameNormalized}, ${c.nameNormalized}) >= ${NAME_SIMILARITY}`))
    .orderBy(sql`similarity(${accounts.nameNormalized}, ${c.nameNormalized}) DESC`)
    .limit(1);
  return m ? { ...m, reason: 'name_city' } : null;
}
