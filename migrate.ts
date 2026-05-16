import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './src/db/client.js';

async function main() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  await pool.end();
}

main().catch(console.error);
