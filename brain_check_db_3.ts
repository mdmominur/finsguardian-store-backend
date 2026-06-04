import { db } from './src/db/client.js';
import { shops, users, products, suppliers, sales, shopUsers } from './src/db/schema/index.js';
import { eq } from 'drizzle-orm';

async function main() {
  try {
    console.log("Reading shops...");
    const allShops = await db.select({ id: shops.id, name: shops.name }).from(shops).limit(10);
    console.log("Shops in database:", allShops);

    for (const shop of allShops) {
      console.log(`\nInspecting data for shop: ${shop.name} (${shop.id})`);
      
      const shopUsersRows = await db.select().from(shopUsers).where(eq(shopUsers.shopId, shop.id));
      console.log(`- ShopUsers count: ${shopUsersRows.length}`);
      for (const su of shopUsersRows) {
        const u = await db.select().from(users).where(eq(users.id, su.userId));
        console.log(`  * User: ${u[0]?.name} (${u[0]?.email}), Role: ${su.role}`);
      }

      const productsRows = await db.select().from(products).where(eq(products.shopId, shop.id));
      console.log(`- Products count: ${productsRows.length}`);
      
      const suppliersRows = await db.select().from(suppliers).where(eq(suppliers.shopId, shop.id));
      console.log(`- Suppliers count: ${suppliersRows.length}`);

      const salesRows = await db.select().from(sales).where(eq(sales.shopId, shop.id));
      console.log(`- Sales count: ${salesRows.length}`);
    }
  } catch (error) {
    console.error("Error inspecting database:", error);
  } finally {
    process.exit(0);
  }
}

main();
