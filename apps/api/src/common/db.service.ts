import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPool, withContext, type DbContext, type Tx } from '@rakan/db';
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext } from './auth-context';

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = createPool(config.DATABASE_URL);
  }

  /** Low-level: explicit context. */
  run<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.pool, ctx, fn);
  }

  /** Tenant-scoped transaction for an authenticated request. */
  tenant<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.pool, { tenantId: auth.tenantId, userId: auth.userId }, fn);
  }

  /** Platform tables only (users, sessions, tenants); tenant rows remain invisible. */
  platform<T>(fn: (tx: Tx) => Promise<T>, userId?: string): Promise<T> {
    return withContext(this.pool, { tenantId: null, userId: userId ?? null }, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres error codes surfaced through drizzle's wrapped errors. */
export function pgErrorCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.cause?.code ?? err?.code;
}
export function pgConstraint(e: unknown): string | undefined {
  const err = e as { constraint?: string; cause?: { constraint?: string } };
  return err?.cause?.constraint ?? err?.constraint;
}
