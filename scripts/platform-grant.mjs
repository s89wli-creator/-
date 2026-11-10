/* eslint-disable no-console -- CLI script */
/**
 * Grants or revokes platform-operator access (the platform console). Deliberately not possible from
 * the web app: it needs direct database owner access.
 *   node scripts/platform-grant.mjs <email>            grant
 *   node scripts/platform-grant.mjs <email> --revoke   revoke
 * Uses MIGRATION_DATABASE_URL (owner role). Operators must turn on two-step verification
 * (enforced in production).
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = require('pg');

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/platform-grant.mjs <email> [--revoke]');
  process.exit(1);
}
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
const grant = flag !== '--revoke';
const c = new Client({ connectionString: url });
await c.connect();
try {
  const r = await c.query('UPDATE users SET is_platform_admin = $2, updated_at = now() WHERE email = $1 RETURNING id', [email.toLowerCase(), grant]);
  if (!r.rowCount) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  await c.query('INSERT INTO platform_audit (actor_user_id, action, after) VALUES (NULL, $1, $2)', [
    grant ? 'platform.operator.grant' : 'platform.operator.revoke', JSON.stringify({ userId: r.rows[0].id, via: 'cli' }),
  ]);
  console.log(`${grant ? 'Granted' : 'Revoked'} platform access for ${email}`);
} finally {
  await c.end();
}
