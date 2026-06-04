import { sql } from 'drizzle-orm';
import { db, pool } from './src/db/client.js';

async function main() {
  console.log('Starting DB migration script...');

  try {
    console.log('Adding max_users to shops...');
    await db.execute(sql`
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS max_users integer NOT NULL DEFAULT 2;
      ALTER TABLE shops ALTER COLUMN max_users SET DEFAULT 2;
      UPDATE shops SET max_users = 2 WHERE max_users = 5;
    `);

    console.log('Adding payment_method_id and payout_amount to refunds...');
    await db.execute(sql`
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES shop_payment_methods(id) ON DELETE RESTRICT;
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS payout_amount numeric(14, 2) NOT NULL DEFAULT '0.00';
      CREATE INDEX IF NOT EXISTS ix_refunds_payment_method ON refunds (payment_method_id) WHERE payment_method_id IS NOT NULL;
    `);

    console.log('Adding payment_method_id and refund_amount to purchase_returns...');
    await db.execute(sql`
      ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES shop_payment_methods(id) ON DELETE RESTRICT;
      ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS refund_amount numeric(14, 2) NOT NULL DEFAULT '0.00';
      CREATE INDEX IF NOT EXISTS ix_purchase_returns_payment_method ON purchase_returns (payment_method_id) WHERE payment_method_id IS NOT NULL;
    `);

    console.log('Migration complete successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await pool.end();
  }
}

main();
