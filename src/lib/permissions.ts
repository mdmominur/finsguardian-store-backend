/**
 * Granular shop access for non-owners. Owners bypass all checks.
 * Keep in sync with frontend `src/lib/permissions-catalog.ts`.
 */
export const PERMISSION_KEYS = [
  'pos.use',
  'customers.manage',
  'receipts.manage',
  'sales.view',
  'sales.refund',
  'finance.pricing',
  'analytics.view',
  'inventory.adjust',
  'inventory.view',
  'locations.manage',
  'purchase_orders.view',
  'purchase_orders.manage',
  'purchase_orders.receive',
  'products.read',
  'products.edit',
  'catalog.taxonomy',
  'devices.registry',
  'warranty.manage',
  /** Customer website: shop settings, homepage slider, policies, product web profiles & assets. */
  'website.manage',
  /** List/filter web-originated invoices (paired with storefront `sales.channel = WEB`). */
  'website.read_orders',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_KEY_SET = new Set<string>(PERMISSION_KEYS);

export function isPermissionKey(s: string): s is PermissionKey {
  return PERMISSION_KEY_SET.has(s);
}

export function sanitizePermissionList(raw: unknown): PermissionKey[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionKey[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && isPermissionKey(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

export type AuthPrincipal = {
  role: 'owner' | 'member';
  permissions: string[];
};

export function hasPermission(auth: AuthPrincipal, key: PermissionKey): boolean {
  if (auth.role === 'owner') return true;
  return auth.permissions.includes(key);
}

export function canManageWebsite(auth: AuthPrincipal): boolean {
  return auth.role === 'owner' || hasPermission(auth, 'website.manage');
}

/** Web-order list access without full `sales.view` (fulfilment staff). */
export function canViewWebOrderInvoices(auth: AuthPrincipal): boolean {
  return (
    auth.role === 'owner' ||
    hasPermission(auth, 'website.manage') ||
    hasPermission(auth, 'website.read_orders')
  );
}

/**
 * Invoice list API: normal sales browse, or web-only list for website fulfilment roles.
 */
export function canListSalesInvoices(
  auth: AuthPrincipal,
  opts?: { channel?: 'POS' | 'WEB' | 'IMPORT' },
): boolean {
  if (auth.role === 'owner') return true;
  if (opts?.channel === 'WEB') {
    return canViewSalesRecords(auth) || canViewWebOrderInvoices(auth);
  }
  return canViewSalesRecords(auth);
}

export function canViewSupplierPricing(auth: AuthPrincipal): boolean {
  return hasPermission(auth, 'finance.pricing');
}

/** List/open sales & invoice detail (and email invoice). POS checkout redirects here — `pos.use` is enough without `sales.view`. */
export function canViewSalesRecords(auth: AuthPrincipal): boolean {
  return hasPermission(auth, 'sales.view') || hasPermission(auth, 'pos.use');
}

/** List categories/brands for filters (product screens) without full taxonomy admin. */
export function canListCatalogForProducts(auth: AuthPrincipal): boolean {
  return (
    hasPermission(auth, 'catalog.taxonomy') ||
    hasPermission(auth, 'products.read') ||
    hasPermission(auth, 'pos.use') ||
    hasPermission(auth, 'inventory.view') ||
    hasPermission(auth, 'inventory.adjust')
  );
}

/**
 * Inventory dashboard (tracked stock list, history, serials from inventory).
 * Broader than catalog-only `products.read` so POS or stock staff can use Inventory without Product master.
 */
export function canUseInventoryDashboard(auth: AuthPrincipal): boolean {
  return (
    hasPermission(auth, 'inventory.view') ||
    hasPermission(auth, 'inventory.adjust') ||
    hasPermission(auth, 'products.read') ||
    hasPermission(auth, 'pos.use')
  );
}

/** List stock locations for pickers (POS checkout, PO receive, adjustments) without full CRUD. */
export function canListStockLocationsForOperations(auth: AuthPrincipal): boolean {
  if (auth.role === 'owner') return true;
  return (
    hasPermission(auth, 'locations.manage') ||
    hasPermission(auth, 'inventory.adjust') ||
    hasPermission(auth, 'purchase_orders.receive') ||
    hasPermission(auth, 'pos.use')
  );
}

/**
 * List in-stock device units for one product (POS serial picker).
 * Full IMEI registry search/edit stays behind `devices.registry`.
 */
export function canListProductSerialsForCheckout(auth: AuthPrincipal): boolean {
  return hasPermission(auth, 'devices.registry') || hasPermission(auth, 'pos.use');
}

/** Pick in-stock serials on purchase return (same people who can post supplier credits). */
export function canListSerialsForPurchaseReturn(auth: AuthPrincipal): boolean {
  if (auth.role === 'owner') return true;
  return (
    hasPermission(auth, 'purchase_orders.manage') &&
    hasPermission(auth, 'finance.pricing')
  );
}

/**
 * Search customers and create a minimal customer during checkout.
 * Editing customers and recording payments stay behind `customers.manage`.
 */
export function canUseCustomersForPosCheckout(auth: AuthPrincipal): boolean {
  return hasPermission(auth, 'customers.manage') || hasPermission(auth, 'pos.use');
}

/**
 * List/search products and read one product (incl. bundle lines) for the counter.
 * Product master edits and SKU admin helpers stay behind `products.read` / `products.edit`.
 */
export function canBrowseProductsForPos(auth: AuthPrincipal): boolean {
  return hasPermission(auth, 'products.read') || hasPermission(auth, 'pos.use');
}
