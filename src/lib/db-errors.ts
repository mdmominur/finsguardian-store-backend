/**
 * Database-error → API-error mapping helpers.
 *
 * Postgres unique violations (SQLSTATE 23505) are the last line of defence for every shop-scoped
 * uniqueness rule (barcode, SKU, phone, serial …). The services pre-check the cases a merchant can
 * actually fix and throw a friendly `AppError`; this module covers the rest — races, and paths that
 * never pre-check — so the client receives a 409 instead of a 500 "Internal error".
 */

/** True when the error is a Postgres unique violation (SQLSTATE 23505). */
export function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505';
}

/** Merchant-readable text for the unique constraint that was violated. */
export function uniqueViolationMessage(constraint: string | undefined): string {
  switch (constraint) {
    case 'ux_products_shop_barcode':
      return 'This barcode is already used by another product';
    case 'ux_psp_shop_barcode':
      return 'This barcode is already enrolled for another product';
    case 'ux_psp_current_per_product':
      return 'This product already has an enrolled packet';
    case 'ux_products_shop_sku_ci':
      return 'This SKU is already used by another product';
    case 'customers_shop_id_phone':
      return 'A customer with this phone number already exists';
    case 'ux_device_units_shop_serial':
      return 'This serial number is already registered';
    case 'ux_device_units_shop_imei1':
    case 'ux_device_units_shop_imei2':
      return 'This IMEI is already registered';
    case 'sales_shop_id_invoice_no':
      return 'This invoice number already exists';
    default:
      return 'A record with these details already exists';
  }
}
