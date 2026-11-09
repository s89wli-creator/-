import { setupDevDatabase } from '../src/dev-setup';
import { runMigrations } from '../src/migrator';

const adminUrl = process.env.ADMIN_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!adminUrl || !appUrl || !ownerUrl) {
  console.error('ADMIN_DATABASE_URL, DATABASE_URL and MIGRATION_DATABASE_URL are required');
  process.exit(1);
}
setupDevDatabase({ adminUrl, appUrl, ownerUrl })
  .then(() => runMigrations(ownerUrl, console.log))
  .then(() => console.log('database ready'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
