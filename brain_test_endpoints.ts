import {
  internalGetShopUsers,
  internalGetShopProducts,
  internalGetShopSuppliers,
  internalGetShopSales,
} from './src/services/internal-dashboard-shops.service.js';

async function main() {
  const nuntelShopId = '6a37bfeb-d005-41ce-9a69-2cb3b2b19361';
  console.log("Testing service query endpoints for Nuntel...");

  try {
    const users = await internalGetShopUsers(nuntelShopId);
    console.log("Users fetched successfully:", users.length);
    console.log(users);

    const products = await internalGetShopProducts(nuntelShopId, 10, 0);
    console.log("Products fetched successfully:", products.total, "total,", products.items.length, "returned");
    console.log(products.items.slice(0, 3));

    const suppliers = await internalGetShopSuppliers(nuntelShopId);
    console.log("Suppliers fetched successfully:", suppliers.length);
    console.log(suppliers);

    const sales = await internalGetShopSales(nuntelShopId, 10, 0);
    console.log("Sales fetched successfully:", sales.total, "total,", sales.items.length, "returned");
    console.log(sales.items.slice(0, 3));

  } catch (error) {
    console.error("FAILED calling query service methods:", error);
  } finally {
    process.exit(0);
  }
}

main();
