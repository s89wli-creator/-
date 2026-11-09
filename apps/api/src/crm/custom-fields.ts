import { customFieldDefs, type Tx } from '@rakan/db';
import { and, eq } from 'drizzle-orm';
import { badRequest } from '../common/errors';

type Def = typeof customFieldDefs.$inferSelect;

/**
 * Validates custom field values against the tenant's definitions.
 * Unknown keys are rejected (no silent junk), empty values remove the key, types are coerced strictly.
 */
export function validateCustomValues(
  defs: Def[],
  values: Record<string, unknown> | undefined,
  existing: Record<string, unknown> = {},
  trackId: string | null = null,
): Record<string, unknown> {
  if (!values) return existing;
  const out: Record<string, unknown> = { ...existing };
  const errors: { path: string; message: string; code: string }[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = defs.find((d) => d.key === key && (!d.trackId || d.trackId === trackId));
    if (!def) {
      errors.push({ path: `customFields.${key}`, message: 'Unknown custom field', code: 'unknown_field' });
      continue;
    }
    if (raw === null || raw === undefined || raw === '') {
      delete out[key];
      continue;
    }
    switch (def.type) {
      case 'text':
        if (typeof raw !== 'string' || raw.length > 1000) errors.push({ path: `customFields.${key}`, message: 'Expected text', code: 'invalid_type' });
        else out[key] = raw.trim();
        break;
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
        if (!Number.isFinite(n)) errors.push({ path: `customFields.${key}`, message: 'Expected number', code: 'invalid_type' });
        else out[key] = n;
        break;
      }
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw)))
          errors.push({ path: `customFields.${key}`, message: 'Expected YYYY-MM-DD', code: 'invalid_date' });
        else out[key] = raw;
        break;
      case 'boolean':
        if (typeof raw === 'boolean') out[key] = raw;
        else if (['true', 'نعم', 'yes', '1'].includes(String(raw).trim().toLowerCase())) out[key] = true;
        else if (['false', 'لا', 'no', '0'].includes(String(raw).trim().toLowerCase())) out[key] = false;
        else errors.push({ path: `customFields.${key}`, message: 'Expected yes/no', code: 'invalid_type' });
        break;
      case 'select':
        if (!def.options?.includes(String(raw))) errors.push({ path: `customFields.${key}`, message: 'Not an allowed option', code: 'invalid_option' });
        else out[key] = String(raw);
        break;
    }
  }
  if (errors.length) throw badRequest('VALIDATION_ERROR', 'Invalid custom field values', errors);
  return out;
}

export function loadDefs(tx: Tx, tenantId: string, entity: 'account' | 'contact' | 'opportunity'): Promise<Def[]> {
  return tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.tenantId, tenantId), eq(customFieldDefs.entity, entity)));
}
