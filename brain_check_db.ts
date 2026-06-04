import { db } from './src/db/client.js';
import { shops, users, products, suppliers, sales, shopUsers } from './src/db/schema/index.js';
import { count } from 'drizzle-orm';

async function main() {
  try {
    console.log("Checking DB counts...");
    
    const [shopCount] = await db.select({ n: count() }).from(shops);
    const [userCount] = await db.select({ n: count() }).from(users);
    const [productCount] = await db.select({ n: count() }).from(products);
    const [supplierCount] = await db.select({ n: count() }).from(suppliers);
    const [saleCount] = await db.select({ n: count() }).from(sales);
    const [shopUserCount] = await db.select({ n: count() }).from(shopUsers);
    
    console.log("Shops count:", shopCount.n);
    console.log("Users count:", userCount.n);
    console.log("Products count:", productCount.n);
    console.log("Suppliers count:", supplierCount.n);
    console.log("Sales count:", saleCount.n);
    console.log("Shop-Users relationship count:", shopUserCount.n);

    // List all shops and a sample of other tables
    const allShops = await db.select().from(shops).limit(5);
    console.log("\nShops sample:");
    console.log(allShops.map(s => ({ id: s.id, name: s.name })));

    if (allShops.length > 0) {
      const targetShopId = allShops[0].id;
      console.log(`\nInspecting data for first shop (${allShops[0].name} - ${targetShopId}):`);
      
      const shopUsersRows = await db.select().from(shopUsers).where({ shopId: targetShopId });
      console.log(`- ShopUsers count for this shop: ${shopUsersRows.length}`);
      
      const productsRows = await db.select().from(products).where({ shopId: targetShopId }).limit(3);
      console.log(`- Products sample for this shop:`, productsRows.map(p => ({ id: p.id, name: p.name })));
      
      const suppliersRows = await db.select().from(suppliers).where({ shopId: targetShopId }).limit(3);
      console.log(`- Suppliers sample for this shop:`, suppliersRows.map(s => ({ id: s.id, name: s.name })));

      const salesRows = await db.select().from(sales).where({ shopId: targetShopId }).limit(3);
      console.log(`- Sales sample for this shop:`, salesRows.map(sl => ({ id: sl.id, invoiceNo: sl.invoiceNo })));
    }
  } catch (error) {
    console.error("Error inspecting database:", error);
  } finally {
    process.exit(0);
  }
}

main();
