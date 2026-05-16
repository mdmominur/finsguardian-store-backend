import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shops } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

/**
 * When false (default): one implicit stock location — clients must not show location pickers;
 * server ignores requested location ids and uses the shop default row.
 */
export function isMultiStockLocationEnabledFromSettings(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  return (settings as Record<string, unknown>).multiStockLocationEnabled === true;
}

export async function isMultiStockLocationEnabled(shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ settings: shops.settings })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!row) return false;
  return isMultiStockLocationEnabledFromSettings(row.settings);
}

/** Optional modules (see docs/plan-shop-feature-flags-and-payments-en.md). */
export type ShopModuleFlags = {
  deviceRegistryEnabled: boolean;
  warrantyModuleEnabled: boolean;
  bundlesModuleEnabled: boolean;
  stockAdjustmentsEnabled: boolean;
  moneyReceiptsModuleEnabled: boolean;
  customerWebsiteEnabled: boolean;
};

const DEFAULT_MODULE_FLAGS: ShopModuleFlags = {
  deviceRegistryEnabled: false,
  warrantyModuleEnabled: false,
  bundlesModuleEnabled: false,
  stockAdjustmentsEnabled: true,
  moneyReceiptsModuleEnabled: true,
  customerWebsiteEnabled: false,
};

export function resolveShopModuleFlags(settings: unknown): ShopModuleFlags {
  const out: ShopModuleFlags = { ...DEFAULT_MODULE_FLAGS };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return out;
  const o = settings as Record<string, unknown>;
  (Object.keys(DEFAULT_MODULE_FLAGS) as (keyof ShopModuleFlags)[]).forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      out[k] = o[k] === true;
    }
  });
  return out;
}

export async function isDeviceRegistryEnabled(shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ settings: shops.settings })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  return resolveShopModuleFlags(row?.settings).deviceRegistryEnabled;
}

export async function assertShopModule(
  shopId: string,
  flag: keyof ShopModuleFlags,
): Promise<void> {
  const [row] = await db
    .select({ settings: shops.settings })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  const flags = resolveShopModuleFlags(row?.settings);
  if (!flags[flag]) {
    throw AppError.featureDisabled(
      'This feature is turned off for your shop. Ask the owner to enable it under Settings → Shop settings.',
    );
  }
}
