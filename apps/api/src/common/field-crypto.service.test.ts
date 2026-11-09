import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { FieldCryptoService } from './field-crypto.service';

const svc = new FieldCryptoService(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' }));
const A = '0000000a-0000-4000-8000-000000000001';
const B = '0000000b-0000-4000-8000-000000000002';

describe('FieldCryptoService', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const c1 = svc.encrypt(A, '+966501234567')!;
    const c2 = svc.encrypt(A, '+966501234567')!;
    expect(c1).not.toBe(c2);
    expect(c1).not.toContain('966');
    expect(svc.decrypt(A, c1)).toBe('+966501234567');
  });
  it('ciphertext from tenant A cannot be decrypted as tenant B', () => {
    const c = svc.encrypt(A, 'secret@x.sa')!;
    expect(() => svc.decrypt(B, c)).toThrow();
  });
  it('detects tampering', () => {
    const c = svc.encrypt(A, 'value')!;
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => svc.decrypt(A, parts.join('.'))).toThrow();
  });
  it('hashes are deterministic per tenant and differ across tenants', () => {
    expect(svc.hash(A, 'x')).toBe(svc.hash(A, 'x'));
    expect(svc.hash(A, 'x')).not.toBe(svc.hash(B, 'x'));
    expect(svc.hash(A, null)).toBeNull();
  });
});
