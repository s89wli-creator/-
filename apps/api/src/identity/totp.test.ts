import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, hotp, totp, verifyTotp } from './totp';

// RFC 4226 / RFC 6238 test vectors (secret = ASCII "12345678901234567890").
const SECRET = Buffer.from('12345678901234567890');
const SECRET_B32 = base32Encode(SECRET);

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trips', () => {
    expect(SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(SECRET_B32).equals(SECRET)).toBe(true);
  });
  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 9].map((c) => hotp(SECRET, c))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });
  it('matches the RFC 6238 SHA1 vectors (8 digits)', () => {
    expect(totp(SECRET_B32, 59_000, 8)).toBe('94287082');
    expect(totp(SECRET_B32, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(SECRET_B32, 1_234_567_890_000, 8)).toBe('89005924');
    expect(totp(SECRET_B32, 20_000_000_000_000, 8)).toBe('65353130');
  });
  it('accepts ±1 step and rejects older codes or wrong formats', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(SECRET_B32, totp(SECRET_B32, now - 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET_B32, totp(SECRET_B32, now + 30_000), now)).toBe(true);
    expect(verifyTotp(SECRET_B32, totp(SECRET_B32, now - 90_000), now)).toBe(false);
    expect(verifyTotp(SECRET_B32, 'abcdef', now)).toBe(false);
  });
  it('recovery codes are unique 10-char codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(codes.every((c) => /^[a-z0-9]{10}$/.test(c))).toBe(true);
  });
});
