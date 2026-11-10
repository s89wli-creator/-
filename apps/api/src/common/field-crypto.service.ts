import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { APP_CONFIG, DEV_ENCRYPTION_KEY, type AppConfig } from '../config';

const VERSION = 'v1';

/**
 * Field-level encryption for personal data (contact phone/email).
 * - Per-tenant keys derived with HKDF(master, salt = tenantId): a key or ciphertext from one tenant
 *   is useless for another, and a tenant can be crypto-shredded later by rotating its salt.
 * - AES-256-GCM (authenticated). Ciphertext format: v1.<iv>.<tag>.<data> (base64url).
 * - Keyed HMAC hashes support exact-match lookup / duplicate detection without decrypting.
 */
@Injectable()
export class FieldCryptoService {
  private readonly master: Buffer;
  private readonly cache = new Map<string, { enc: Buffer; mac: Buffer }>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.master = Buffer.from(config.DATA_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY, 'base64');
  }

  private keys(tenantId: string) {
    let k = this.cache.get(tenantId);
    if (!k) {
      k = {
        enc: Buffer.from(hkdfSync('sha256', this.master, tenantId, 'rakan-field-enc-v1', 32)),
        mac: Buffer.from(hkdfSync('sha256', this.master, tenantId, 'rakan-field-mac-v1', 32)),
      };
      this.cache.set(tenantId, k);
    }
    return k;
  }

  encrypt(tenantId: string, plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys(tenantId).enc, iv);
    cipher.setAAD(Buffer.from(tenantId));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(tenantId: string, value: string | null | undefined): string | null {
    if (!value) return null;
    const [version, iv, tag, data] = value.split('.');
    if (version !== VERSION || !iv || !tag || !data) throw new Error('Unsupported ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.keys(tenantId).enc, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(tenantId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Binary payloads (audio files): iv(12) | tag(16) | ciphertext, bound to tenant + object key. */
  encryptBuffer(tenantId: string, objectKey: string, data: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys(tenantId).enc, iv);
    cipher.setAAD(Buffer.from(`${tenantId}:${objectKey}`));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decryptBuffer(tenantId: string, objectKey: string, blob: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.keys(tenantId).enc, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${tenantId}:${objectKey}`));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  }

  hash(tenantId: string, normalized: string | null | undefined): string | null {
    if (!normalized) return null;
    return createHmac('sha256', this.keys(tenantId).mac).update(normalized).digest('hex');
  }
}
