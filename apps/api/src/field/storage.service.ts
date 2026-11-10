import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config';
import { FieldCryptoService } from '../common/field-crypto.service';

/**
 * Encrypted blob storage. Every object is AES-256-GCM encrypted with the company key and bound to its
 * own key name, so a file copied to another company's path cannot be decrypted there.
 * Keys are always `<tenantId>/...`; paths are resolved and checked to stay inside the storage root.
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly crypto: FieldCryptoService,
  ) {
    this.root = resolve(config.STORAGE_DIR);
  }

  private path(tenantId: string, key: string): string {
    if (!key.startsWith(`${tenantId}/`) || key.includes('..')) throw new Error('Invalid storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(tenantId: string, key: string, data: Buffer): Promise<void> {
    const p = this.path(tenantId, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, this.crypto.encryptBuffer(tenantId, key, data), { mode: 0o600 });
  }

  async get(tenantId: string, key: string): Promise<Buffer> {
    return this.crypto.decryptBuffer(tenantId, key, await readFile(this.path(tenantId, key)));
  }

  async remove(tenantId: string, key: string): Promise<void> {
    await rm(this.path(tenantId, key), { force: true, recursive: true });
  }
}
