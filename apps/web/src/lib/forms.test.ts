import { loginSchema, registerSchema, tenantSettingsSchema } from '@rakan/shared';
import { describe, expect, it } from 'vitest';
import { validate } from './forms';

describe('validate', () => {
  it('reports empty fields as required', () => {
    const r = validate(registerSchema, { fullName: '', email: '', password: '', companyName: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) for (const k of ['fullName', 'email', 'password', 'companyName']) expect(r.errors[k]?.key).toBe('form.required');
  });
  it('reports specific problems for filled fields', () => {
    const r = validate(registerSchema, { fullName: 'A', email: 'nope', password: 'short', companyName: 'Acme' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.fullName).toEqual({ key: 'form.tooShort', vars: { min: 2 } });
      expect(r.errors.email?.key).toBe('form.invalidEmail');
      expect(r.errors.password).toEqual({ key: 'form.tooShort', vars: { min: 12 } });
    }
  });
  it('maps CR and VAT format errors to dedicated messages', () => {
    const r = validate(tenantSettingsSchema, { crNumber: '123', vatNumber: '999' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.crNumber?.key).toBe('form.cr');
      expect(r.errors.vatNumber?.key).toBe('form.vat');
    }
  });
  it('normalizes valid input (email lower-cased)', () => {
    const r = validate(loginSchema, { email: ' Owner@Acme.SA ', password: 'x' });
    expect(r).toEqual({ ok: true, data: { email: 'owner@acme.sa', password: 'x' } });
  });
});
