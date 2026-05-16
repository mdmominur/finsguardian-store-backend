import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth.routes.js';
import { registerProductRoutes } from './products.routes.js';
import { registerCatalogRoutes } from './catalog.routes.js';
import { registerDeviceRoutes } from './devices.routes.js';
import { registerStockAdjustmentRoutes } from './stock-adjustments.routes.js';
import { registerSupplierRoutes } from './suppliers.routes.js';
import { registerPurchaseOrderRoutes } from './purchase-orders.routes.js';
import { registerPurchaseReturnRoutes } from './purchase-returns.routes.js';
import { registerPosRoutes } from './pos.routes.js';
import { registerSaleRoutes } from './sales.routes.js';
import { registerReportRoutes } from './reports.routes.js';
import { registerWarrantyRoutes } from './warranty.routes.js';
import { registerCustomerRoutes } from './customers.routes.js';
import { registerExpenseRoutes } from './expenses.routes.js';
import { registerFinanceAccountRoutes } from './finance-accounts.routes.js';
import { registerShopPaymentMethodRoutes } from './shop-payment-methods.routes.js';
import { registerCashDrawerRoutes } from './cash-drawer.routes.js';
import { registerLocationRoutes } from './locations.routes.js';
import { registerAjkerHisabRoutes } from './ajker-hisab.routes.js';
import { registerReceiptRoutes } from './receipts.routes.js';
import { registerShareRoutes } from './share.routes.js';
import { registerShopSettingsRoutes } from './shop-settings.routes.js';
import { registerShopWebsiteRoutes } from './shop-website.routes.js';
import { registerWebsiteRoutes } from './website.routes.js';
import { registerPaymentMethodAdjustmentRoutes } from './payment-method-adjustments.routes.js';
import { registerProductBatchRoutes } from './product-batches.routes.js';
import { registerBatchIntegrityRoutes } from './batch-integrity.routes.js';
import { registerUomRoutes } from './uoms.routes.js';
import { registerPublicCustomerAuthRoutes } from './public-customer-auth.routes.js';
import { registerPublicCustomerRoutes } from './public-customer.routes.js';
import { registerDeliveryLocationRoutes } from './delivery-locations.routes.js';

export async function registerV1Routes(app: FastifyInstance) {
  await app.register(
    async (r) => {
      await registerAuthRoutes(r);
      await registerProductRoutes(r);
      await registerCatalogRoutes(r);
      await registerDeviceRoutes(r);
      await registerStockAdjustmentRoutes(r);
      await registerSupplierRoutes(r);
      await registerPurchaseOrderRoutes(r);
      await registerPurchaseReturnRoutes(r);
      await registerPosRoutes(r);
      await registerSaleRoutes(r);
      await registerReportRoutes(r);
      await registerWarrantyRoutes(r);
      await registerCustomerRoutes(r);
      await registerExpenseRoutes(r);
      await registerFinanceAccountRoutes(r);
      await registerShopPaymentMethodRoutes(r);
      await registerCashDrawerRoutes(r);
      await registerLocationRoutes(r);
      await registerDeliveryLocationRoutes(r);
      await registerAjkerHisabRoutes(r);
      await registerReceiptRoutes(r);
      await registerShareRoutes(r);
      await registerShopSettingsRoutes(r);
      await registerShopWebsiteRoutes(r);
      await registerWebsiteRoutes(r);
      await registerPublicCustomerAuthRoutes(r);
      await registerPublicCustomerRoutes(r);
      await registerPaymentMethodAdjustmentRoutes(r);
      await registerProductBatchRoutes(r);
      await registerBatchIntegrityRoutes(r);
      await registerUomRoutes(r);
    },
    { prefix: '/api/v1' },
  );
}
