import { describe, expect, it } from 'vitest';
import { errorMessage, messages } from './i18n';

// Every error code the API can return must have a translation in both languages.
const API_ERROR_CODES = [
  'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'EMAIL_TAKEN', 'VALIDATION_ERROR', 'RATE_LIMITED', 'FORBIDDEN', 'NOT_FOUND',
  'UNAUTHENTICATED', 'INVALID_TOKEN', 'ALREADY_MEMBER', 'LAST_OWNER', 'NAME_TAKEN', 'INVALID_MEMBER', 'CSRF_INVALID',
  'NO_ACTIVE_TENANT', 'LOGIN_REQUIRED', 'INVITATION_EXPIRED', 'INVITATION_USED',
];

describe('i18n', () => {
  it('Arabic and English dictionaries have identical keys', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.ar).sort());
  });
  it('no empty translations', () => {
    for (const l of ['ar', 'en'] as const) {
      expect(Object.entries(messages[l]).filter(([, v]) => !v.trim())).toEqual([]);
    }
  });
  it('translates every API error code', () => {
    for (const code of API_ERROR_CODES) {
      expect(errorMessage('ar', code), code).not.toBe(messages.ar['errors.UNKNOWN']);
      expect(errorMessage('en', code), code).not.toBe(messages.en['errors.UNKNOWN']);
    }
  });
  it('falls back for unknown codes', () => {
    expect(errorMessage('ar', 'SOMETHING_NEW')).toBe(messages.ar['errors.UNKNOWN']);
  });
});
