import { describe, expect, it } from 'vitest';
import { redact } from './audit.service';

describe('audit redaction', () => {
  it('strips secret-looking keys at any depth', () => {
    expect(
      redact({ email: 'a@b.sa', password: 'x', nested: { tokenHash: 'h', ok: 1 }, list: [{ secret: 's', name: 'n' }] }),
    ).toEqual({ email: 'a@b.sa', nested: { ok: 1 }, list: [{ name: 'n' }] });
  });
});
