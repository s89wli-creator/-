import { describe, expect, it } from 'vitest';
import { errorMessage, messages } from './i18n';
import { arAgents } from './i18n-agents';
import { arAi } from './i18n-ai';
import { arCrm } from './i18n-crm';
import { arField } from './i18n-field';
import { arPlatform } from './i18n-platform';
import { arProposals } from './i18n-proposals';
import { arVoice } from './i18n-voice';

// Every error code the API can return must have a translation in both languages.
const API_ERROR_CODES = [
  'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'EMAIL_TAKEN', 'VALIDATION_ERROR', 'RATE_LIMITED', 'FORBIDDEN', 'NOT_FOUND',
  'UNAUTHENTICATED', 'INVALID_TOKEN', 'ALREADY_MEMBER', 'LAST_OWNER', 'NAME_TAKEN', 'INVALID_MEMBER', 'CSRF_INVALID',
  'NO_ACTIVE_TENANT', 'LOGIN_REQUIRED', 'INVITATION_EXPIRED', 'INVITATION_USED',
  'DUPLICATE_ACCOUNT', 'REASON_REQUIRED', 'STAGE_IN_USE', 'INVALID_REFERENCE', 'INVALID_STATE', 'INVALID_STAGE', 'INVALID_RANGE',
  'TOO_MANY_ROWS', 'EMPTY_FILE', 'INVALID_FILE', 'UNSUPPORTED_FILE', 'NO_FILE', 'PAYLOAD_TOO_LARGE', 'INVALID_MAPPING', 'INVALID_ROW',
  'INVALID_RESOLUTION', 'PERMISSION_NOT_CONFIRMED',
];

describe('i18n', () => {
  it('feature dictionaries never reuse a key (a later one would silently replace the earlier text)', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [name, dict] of Object.entries({ arCrm, arAi, arField, arPlatform, arAgents, arVoice, arProposals })) {
      for (const k of Object.keys(dict)) {
        if (seen.has(k)) dupes.push(`${k} (${seen.get(k)} / ${name})`);
        seen.set(k, name);
      }
    }
    expect(dupes).toEqual([]);
  });
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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('error code coverage', () => {
  it('every error code thrown by the API has an Arabic and English translation', () => {
    const codes = new Set<string>();
    for (const file of sources(join(__dirname, '../../../api/src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:AppError\(\s*\d+,\s*|badRequest\(\s*|conflict\(\s*)'([A-Z_]{3,})'/g)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(20);
    const missing = [...codes].filter((c) => errorMessage('ar', c) === messages.ar['errors.UNKNOWN'] || errorMessage('en', c) === messages.en['errors.UNKNOWN']);
    expect(missing).toEqual([]);
  });
});
