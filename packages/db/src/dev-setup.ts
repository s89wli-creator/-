import { Client } from 'pg';

/**
 * Development/CI only: creates the database and the two roles.
 *  - owner role: owns the schema, runs migrations (BYPASSRLS so test fixtures and
 *    maintenance can operate; never used by the running application).
 *  - app role: used by the API/worker. NOSUPERUSER NOBYPASSRLS => RLS always applies.
 * In production these roles are provisioned by infrastructure, not by this script.
 */
export async function setupDevDatabase(opts: { adminUrl: string; appUrl: string; ownerUrl: string }): Promise<void> {
  const app = new URL(opts.appUrl);
  const owner = new URL(opts.ownerUrl);
  const dbName = owner.pathname.slice(1);
  const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';
  const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";

  const admin = new Client({ connectionString: opts.adminUrl });
  await admin.connect();
  try {
    const upsertRole = async (name: string, password: string, extra: string) => {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      await admin.query(`${verb} ROLE ${ident(name)} LOGIN PASSWORD ${lit(password)} ${extra}`);
    };
    await upsertRole(decodeURIComponent(owner.username), decodeURIComponent(owner.password), 'NOSUPERUSER BYPASSRLS');
    await upsertRole(decodeURIComponent(app.username), decodeURIComponent(app.password), 'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
    const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!db.rowCount) await admin.query(`CREATE DATABASE ${ident(dbName)} OWNER ${ident(decodeURIComponent(owner.username))}`);
  } finally {
    await admin.end();
  }

  // Extensions require superuser on most installs; create them as admin in the target DB.
  const adminOnDb = new URL(opts.adminUrl);
  adminOnDb.pathname = '/' + dbName;
  const c = new Client({ connectionString: adminOnDb.toString() });
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await c.query('CREATE EXTENSION IF NOT EXISTS citext');
    await c.query(`GRANT ALL ON SCHEMA public TO ${ident(decodeURIComponent(owner.username))}`);
  } finally {
    await c.end();
  }
}
