import type { ZodTypeAny, z } from 'zod';
import type { MessageKey } from './i18n';

export type FieldErrors = Record<string, { key: MessageKey; vars?: Record<string, number> }>;

interface IssueLike {
  path: (string | number)[];
  code: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  validation?: string;
  message: string;
}

/** Maps a zod issue to a translatable message (same schema runs on client and server). */
export function issueToMessage(issue: IssueLike): { key: MessageKey; vars?: Record<string, number> } {
  const field = String(issue.path[0] ?? '');
  if (field === 'crNumber') return { key: 'form.cr' };
  if (field === 'vatNumber') return { key: 'form.vat' };
  if (issue.code === 'invalid_string' && issue.validation === 'email') return { key: 'form.invalidEmail' };
  if (issue.code === 'too_small') {
    return Number(issue.minimum) <= 1 ? { key: 'form.required' } : { key: 'form.tooShort', vars: { min: Number(issue.minimum) } };
  }
  if (issue.code === 'too_big') return { key: 'form.tooLong', vars: { max: Number(issue.maximum) } };
  if (issue.code === 'invalid_type') return { key: 'form.required' };
  return { key: 'form.invalid' };
}

export function validate<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; errors: FieldErrors } {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data };
  const errors: FieldErrors = {};
  const values = (data ?? {}) as Record<string, unknown>;
  for (const issue of r.error.issues as IssueLike[]) {
    const k = String(issue.path[0] ?? '_');
    const v = values[k];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    errors[k] ??= empty ? { key: 'form.required' } : issueToMessage(issue);
  }
  return { ok: false, errors };
}

export function formObject(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
}
