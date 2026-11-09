import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { createPool, withContext } from './context';
import { runMigrations } from './migrator';
import { memberships, territories } from './schema';

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
const run = ownerUrl && appUrl ? describe : describe.skip;

run('row-level security', () => {
  let owner: Client;
  let pool: Pool;
  const A = '0000000a-0000-4000-8000-000000000001';
  const B = '0000000b-0000-4000-8000-000000000002';
  const userA = '0000000a-0000-4000-8000-0000000000aa';
  const userB = '0000000b-0000-4000-8000-0000000000bb';

  beforeAll(async () => {
    await runMigrations(ownerUrl!);
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query('DELETE FROM tenants WHERE id IN ($1,$2)', [A, B]);
    await owner.query('DELETE FROM users WHERE id IN ($1,$2)', [userA, userB]);
    await owner.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,'A','rls-a'),($2,'B','rls-b')`, [A, B]);
    await owner.query(`INSERT INTO users (id, email, full_name) VALUES ($1,'rls-a@x.test','A'),($2,'rls-b@x.test','B')`, [userA, userB]);
    await owner.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`, [A, userA, B, userB]);
    await owner.query(`INSERT INTO territories (tenant_id, name) VALUES ($1,'الرياض'),($2,'جدة')`, [A, B]);
    pool = createPool(appUrl!);
  });

  afterAll(async () => {
    await owner?.query('DELETE FROM tenants WHERE id IN ($1,$2)', [A, B]);
    await owner?.query('DELETE FROM users WHERE id IN ($1,$2)', [userA, userB]);
    await owner?.end();
    await pool?.end();
  });

  it('every table with tenant_id has RLS enabled, forced, and a policy', async () => {
    const { rows } = await owner.query<{ table: string; rls: boolean; forced: boolean; policies: number }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table);
    expect(bad).toEqual([]);
  });

  it('application role cannot bypass RLS', async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    const { rows } = await c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    await c.end();
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('fails closed with no tenant context', async () => {
    const rows = await withContext(pool, { tenantId: null }, (tx) => tx.select().from(territories));
    expect(rows).toEqual([]);
  });

  it('sees only the current tenant rows', async () => {
    const rows = await withContext(pool, { tenantId: A }, (tx) => tx.select().from(territories));
    expect(rows.map((r) => r.tenantId)).toEqual([A]);
  });

  it('rejects writes tagged with another tenant', async () => {
    const err = await withContext(pool, { tenantId: A }, (tx) =>
      tx.insert(territories).values({ tenantId: B, name: 'x' }),
    ).catch((e: Error & { cause?: Error }) => e);
    expect(String((err as Error & { cause?: Error }).cause?.message)).toMatch(/row-level security/);
  });

  it('user sees own memberships across tenants but not other users', async () => {
    const rows = await withContext(pool, { tenantId: null, userId: userA }, (tx) => tx.select().from(memberships));
    expect(rows.map((r) => r.userId)).toEqual([userA]);
  });

  it('context does not leak between pooled transactions', async () => {
    await withContext(pool, { tenantId: A }, async () => {});
    const rows = await withContext(pool, { tenantId: null }, (tx) => tx.select().from(territories));
    expect(rows).toEqual([]);
  });

  it('application role cannot modify the audit log', async () => {
    await expect(
      withContext(pool, { tenantId: A }, (tx) => tx.$client.query('DELETE FROM audit_logs')),
    ).rejects.toThrow(/permission denied/);
  });
});
