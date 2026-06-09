import { db } from './src/db/client.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    console.log("Checking tables in database...");
    const tables = await db.execute(sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log("Tables:");
    console.log(tables.rows.map(r => r.table_name));

    console.log("\nChecking columns for categories, brands, products, sale_payments...");
    const cols = await db.execute(sql`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name IN ('categories', 'brands', 'products', 'sale_payments')
      ORDER BY table_name, column_name;
    `);
    console.log(cols.rows);

    console.log("\nChecking drizzle migrations table...");
    try {
      const migrations = await db.execute(sql`SELECT * FROM "drizzle"."__drizzle_migrations" ORDER BY id DESC;`);
      console.log("Migration records:", migrations.rows);
    } catch (e: any) {
      console.log("Error querying drizzle.__drizzle_migrations table:", e.message);
    }
  } catch (error) {
    console.error("Error inspecting database:", error);
  } finally {
    process.exit(0);
  }
}

main();
