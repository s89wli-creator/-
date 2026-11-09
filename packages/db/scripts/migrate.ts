import { runMigrations } from '../src/migrator';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required');
  process.exit(1);
}
runMigrations(url, console.log)
  .then((ran) => console.log(ran.length ? `applied ${ran.length} migration(s)` : 'database is up to date'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
