import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as baseSchema from './schema';
import * as aiSchema from './schema-ai';
import * as fieldSchema from './schema-field';
import * as platformSchema from './schema-platform';
import * as proposalsSchema from './schema-proposals';
import * as agentsSchema from './schema-agents';
import * as crmSchema from './schema-crm';

const schema = { ...baseSchema, ...crmSchema, ...aiSchema, ...fieldSchema, ...platformSchema, ...agentsSchema, ...proposalsSchema };

export type Tx = NodePgDatabase<typeof schema> & { $client: PoolClient };

export interface DbContext {
  /** Tenant whose rows are visible. null = platform-only access (no tenant rows visible). */
  tenantId: string | null;
  /** Signed-in user (enables "own memberships" visibility across tenants). */
  userId?: string | null;
  /** Lets an invitation be read by presenting its token hash (acceptance flow only). */
  invitationTokenHash?: string | null;
}

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max });
}

/**
 * Runs `fn` inside a transaction whose RLS context is set with SET LOCAL semantics
 * (set_config(..., true)), so it can never leak to another request using the same
 * pooled connection. Every tenant data access in the app MUST go through here.
 */
export async function withContext<T>(pool: Pool, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.invitation_token_hash', $3, true)`,
      [ctx.tenantId ?? '', ctx.userId ?? '', ctx.invitationTokenHash ?? ''],
    );
    const tx = drizzle(client, { schema }) as Tx;
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Changes the tenant context mid-transaction (e.g. right after creating a tenant). */
export async function setTenantContext(tx: Tx, tenantId: string): Promise<void> {
  await tx.$client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}
