import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env') });
import { db } from '../src/db/client.js';
import { shops } from '../src/db/schema/tables.js';
import { dashboardSummary } from '../src/services/report.service.js';

async function main() {
  const [s] = await db.select().from(shops).limit(1);
  if (!s) {
    console.error('no shop');
    process.exit(1);
  }
  const from = new Date(Date.now() - 7 * 864e5);
  const to = new Date();
  const d = await dashboardSummary(s.id, from, to);
  console.log('OK', Object.keys(d));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
