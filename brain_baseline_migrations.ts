import { db } from './src/db/client.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import crypto from 'crypto';

async function main() {
  try {
    console.log("Reading _journal.json...");
    const journalPath = './drizzle/meta/_journal.json';
    if (!fs.existsSync(journalPath)) {
      throw new Error(`Can't find ${journalPath}`);
    }

    const journalContent = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const entries = journalContent.entries;
    console.log(`Found ${entries.length} entries in journal.`);

    // Ensure drizzle schema and __drizzle_migrations table exist
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    // Fetch existing db migrations
    const dbMigrationsResult = await db.execute(sql`
      SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"
    `);
    const dbMigrations = dbMigrationsResult.rows as { hash: string, created_at: string }[];
    const dbMigrationHashes = new Set(dbMigrations.map(m => m.hash));

    console.log("Current migrations in DB:", dbMigrations);

    for (const entry of entries) {
      const sqlPath = `./drizzle/${entry.tag}.sql`;
      if (!fs.existsSync(sqlPath)) {
        console.warn(`File ${sqlPath} not found!`);
        continue;
      }

      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');
      const folderMillis = entry.when;

      console.log(`Migration ${entry.tag}:`);
      console.log(`- created_at (when): ${folderMillis}`);
      console.log(`- hash: ${hash}`);

      const alreadyExists = dbMigrations.some(m => Number(m.created_at) === folderMillis);
      if (alreadyExists) {
        console.log(`- Status: Already registered in DB`);
      } else {
        console.log(`- Status: Registering in DB...`);
        await db.execute(sql`
          INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
          VALUES (${hash}, ${folderMillis})
        `);
        console.log(`- Status: Registered successfully`);
      }
    }

    console.log("\nBaselining complete!");
  } catch (error) {
    console.error("Error baselining database:", error);
  } finally {
    process.exit(0);
  }
}

main();
