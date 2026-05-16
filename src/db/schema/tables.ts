/**
 * Drizzle schema — mirrors docs/sql/001_initial_schema.sql (do not drift without migration).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const shops = pgTable(
  'shops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').unique(),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Trial ends 30 calendar days after shop creation (Asia/Dhaka policy can be applied in app). */
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }).notNull(),
    /** Last instant covered by manual subscription payments (excludes trial). */
    paidThrough: timestamp('paid_through', { withTimezone: true }),
    subscriptionStatus: text('subscription_status').notNull(),
  },
  (t) => [
    check(
      'shops_subscription_status_chk',
      sql`${t.subscriptionStatus} IN ('trialing', 'active', 'lapsed', 'suspended')`,
    ),
  ],
);

export const shopWebsiteAssets = pgTable(
  'shop_website_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_shop_website_assets_shop_kind').on(t.shopId, t.kind, t.createdAt),
    uniqueIndex('ux_shop_website_assets_shop_key').on(t.shopId, t.key),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').unique(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'users_contact_chk',
      sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`,
    ),
  ],
);

export const shopUsers = pgTable(
  'shop_users',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.userId] }),
    check('shop_users_role_chk', sql`${t.role} IN ('owner', 'member')`),
    index('ix_shop_users_user').on(t.userId),
  ],
);

export const uoms = pgTable(
  'uoms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    symbol: text('symbol'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ux_uoms_shop_name_ci').on(t.shopId, sql`lower(${t.name})`),
    index('ix_uoms_shop_time').on(t.shopId, t.createdAt),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ipInet: text('ip_inet'),
  },
  (t) => [
    index('ix_refresh_tokens_user').on(t.userId),
    index('ix_refresh_tokens_expires').on(t.expiresAt),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Self-FK in SQL; plain uuid here avoids TS circular inference. */
    parentId: uuid('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Inactive categories are hidden from product pickers; deactivating a parent deactivates descendants. */
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_categories_shop_parent').on(t.shopId, t.parentId),
    index('ix_categories_shop_sort').on(t.shopId, t.sortOrder),
  ],
);

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Inactive brands are hidden from product pickers (no hard delete). */
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brands_shop_id_name').on(t.shopId, t.name)],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    barcode: text('barcode'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    uomId: uuid('uom_id').references(() => uoms.id, { onDelete: 'set null' }),
    trackingMode: text('tracking_mode').notNull(),
    costMethod: text('cost_method').notNull().default('MOVING_AVG'),
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    listPrice: numeric('list_price', { precision: 14, scale: 2 }).notNull().default('0'),
    minStockLevel: integer('min_stock_level').notNull().default(0),
    /** QUANTITY: when false, POS skips stock warnings and checkout skips balance deduction. */
    inventoryTracked: boolean('inventory_tracked').notNull().default(true),
    /**
     * QUANTITY only: when true, this product must be received/adjusted/sold through batches (FEFO).
     * When false, product uses simple bulk quantity tracking (no batches).
     */
    batchTrackingEnabled: boolean('batch_tracking_enabled').notNull().default(false),
    /**
     * When batchTrackingEnabled is true, whether manufactured/expires dates are required for incoming
     * stock batches. (Policy chosen per shop rollout; enforced in services.)
     */
    batchDatesRequired: boolean('batch_dates_required').notNull().default(false),
    isBundle: boolean('is_bundle').notNull().default(false),
    active: boolean('active').notNull().default(true),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'products_tracking_mode_chk',
      sql`${t.trackingMode} IN ('SERIALIZED', 'QUANTITY')`,
    ),
    check(
      'products_cost_method_chk',
      sql`${t.costMethod} IN ('MOVING_AVG', 'FIFO')`,
    ),
    uniqueIndex('ux_products_shop_sku_ci').on(t.shopId, sql`lower(${t.sku})`),
    uniqueIndex('ux_products_shop_barcode')
      .on(t.shopId, t.barcode)
      .where(sql`${t.barcode} IS NOT NULL AND btrim(${t.barcode}) <> ''`),
    index('ix_products_shop_active_name').on(t.shopId, t.active, sql`lower(${t.name})`),
    index('ix_products_shop_category')
      .on(t.shopId, t.categoryId)
      .where(sql`${t.active}`),
    index('ix_products_shop_brand')
      .on(t.shopId, t.brandId)
      .where(sql`${t.active}`),
  ],
);

export const productWebsiteProfiles = pgTable(
  'product_website_profiles',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    visible: boolean('visible').notNull().default(false),
    /** Optional H1 / listing title override; storefront falls back to `products.name`. */
    webTitle: text('web_title'),
    /** Unique per shop when set; URL segment for `/p/{slug}` on the public site. */
    seoSlug: text('seo_slug'),
    sortOrder: integer('sort_order').notNull().default(0),
    featured: boolean('featured').notNull().default(false),
    shortDescription: text('short_description'),
    longDescription: text('long_description'),
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    ogImageUrl: text('og_image_url'),
    tags: text('tags'),
    canonicalUrl: text('canonical_url'),
    twitterTitle: text('twitter_title'),
    twitterDescription: text('twitter_description'),
    twitterImageUrl: text('twitter_image_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.productId] }),
    index('ix_product_website_profiles_shop_visible').on(t.shopId, t.visible, t.updatedAt),
    uniqueIndex('ux_product_website_profiles_shop_seo_slug')
      .on(t.shopId, sql`lower(btrim(${t.seoSlug}))`)
      .where(sql`${t.seoSlug} IS NOT NULL AND btrim(${t.seoSlug}) <> ''`),
    index('ix_product_website_profiles_shop_featured')
      .on(t.shopId, t.featured)
      .where(sql`${t.featured} = true AND ${t.visible} = true`),
  ],
);

export const productWebsiteImages = pgTable(
  'product_website_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // COVER | GALLERY
    url: text('url').notNull(),
    altText: text('alt_text'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_product_website_images_shop_product_kind').on(
      t.shopId,
      t.productId,
      t.kind,
      t.sortOrder,
    ),
  ],
);

export const bundleItems = pgTable(
  'bundle_items',
  {
    bundleProductId: uuid('bundle_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    componentProductId: uuid('component_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bundleProductId, t.componentProductId] }),
    check('bundle_items_quantity_chk', sql`${t.quantity} > 0`),
    check('bundle_no_self', sql`${t.bundleProductId} <> ${t.componentProductId}`),
  ],
);

export const stockLocations = pgTable(
  'stock_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_locations_shop_id_name').on(t.shopId, t.name),
    uniqueIndex('ux_stock_locations_one_default_per_shop')
      .on(t.shopId)
      .where(sql`${t.isDefault}`),
  ],
);

export const deviceUnits = pgTable(
  'device_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    /** Immutable per-unit serial (required). */
    serial: text('serial').notNull(),
    /** Optional IMEI 1 (separate from serial). */
    imei1: text('imei1'),
    imei2: text('imei2'),
    status: text('status').notNull().default('IN_STOCK'),
    blocklisted: boolean('blocklisted').notNull().default(false),
    blocklistReason: text('blocklist_reason'),
    channelTag: text('channel_tag'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** DB FK to purchase_order_lines / sale_lines (defined later in SQL; omit Drizzle FK to avoid init order issues). */
    receivedPoLineId: uuid('received_po_line_id'),
    soldSaleLineId: uuid('sold_sale_line_id'),
    /** Current stock location / bin while IN_STOCK (optional history on sale). */
    stockLocationId: uuid('stock_location_id').references(() => stockLocations.id, {
      onDelete: 'set null',
    }),
    uniqueIdentifier: text('unique_identifier'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'device_units_status_chk',
      sql`${t.status} IN ('IN_STOCK', 'SOLD', 'RMA', 'TRANSFERRED', 'SCRAPPED', 'RETURNED_TO_SUPPLIER')`,
    ),
    check(
      'device_units_channel_chk',
      sql`${t.channelTag} IS NULL OR ${t.channelTag} IN ('OFFICIAL', 'UNOFFICIAL')`,
    ),
    check(
      'device_imei_distinct_chk',
      sql`${t.imei1} IS NULL OR ${t.imei2} IS NULL OR ${t.imei1} <> ${t.imei2}`,
    ),
    uniqueIndex('ux_device_units_shop_serial').on(t.shopId, t.serial),
    uniqueIndex('ux_device_units_shop_imei1')
      .on(t.shopId, t.imei1)
      .where(sql`${t.imei1} IS NOT NULL AND btrim(${t.imei1}) <> ''`),
    uniqueIndex('ux_device_units_shop_imei2')
      .on(t.shopId, t.imei2)
      .where(sql`${t.imei2} IS NOT NULL AND btrim(${t.imei2}) <> ''`),
    index('ix_device_units_shop_product_status').on(t.shopId, t.productId, t.status),
    index('ix_device_units_shop_status')
      .on(t.shopId, t.status)
      .where(sql`NOT ${t.blocklisted}`),
  ],
);

export const inventoryBalances = pgTable(
  'inventory_balances',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'cascade' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.productId, t.locationId] }),
    check('inventory_balances_qty_chk', sql`${t.quantity} >= 0`),
  ],
);

// -----------------------------------------------------------------------------
// Product batches (lot/expiry groups) — for QUANTITY products with FEFO flows
// -----------------------------------------------------------------------------

export const productBatches = pgTable(
  'product_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Internal batch code (auto-generated). */
    batchCode: text('batch_code').notNull(),
    /** Optional vendor/supplier-printed lot code. */
    supplierLotCode: text('supplier_lot_code'),
    manufacturedAt: date('manufactured_at'),
    expiresAt: date('expires_at'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ux_product_batches_shop_product_code').on(t.shopId, t.productId, t.batchCode),
    index('ix_product_batches_shop_product_exp').on(t.shopId, t.productId, t.expiresAt),
    index('ix_product_batches_shop_product_created').on(t.shopId, t.productId, t.createdAt),
  ],
);

/** Per-location quantity on hand for a batch. */
export const batchInventoryBalances = pgTable(
  'batch_inventory_balances',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => productBatches.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'cascade' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.batchId, t.locationId] }),
    check('batch_inventory_balances_qty_chk', sql`${t.quantity} >= 0`),
    index('ix_batch_bal_shop_loc').on(t.shopId, t.locationId),
  ],
);

/** Append-only movements for batch stock (auditable FEFO allocation). */
export const batchInventoryMovements = pgTable(
  'batch_inventory_movements',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => productBatches.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    quantityDelta: numeric('quantity_delta', { precision: 14, scale: 3 }).notNull(),
    movementType: text('movement_type').notNull(),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('ix_batch_mov_shop_batch_time').on(t.shopId, t.batchId, t.createdAt),
    index('ix_batch_mov_shop_prod_time').on(t.shopId, t.productId, t.createdAt),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    quantityDelta: numeric('quantity_delta', { precision: 14, scale: 3 }).notNull(),
    movementType: text('movement_type').notNull(),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('ix_inv_mov_shop_product_time').on(t.shopId, t.productId, t.createdAt),
    index('ix_inv_mov_shop_time').on(t.shopId, t.createdAt),
  ],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),
    openingBalance: numeric('opening_balance', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_suppliers_shop_name').on(t.shopId, sql`lower(${t.name})`)],
);

export const supplierLedgerEntries = pgTable(
  'supplier_ledger_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    entryType: text('entry_type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'supplier_ledger_entries_type_chk',
      sql`${t.entryType} IN ('PURCHASE', 'PAYMENT', 'ADJUSTMENT', 'OPENING', 'PURCHASE_RETURN')`,
    ),
    index('ix_supplier_ledger_supplier_time').on(t.supplierId, t.createdAt),
  ],
);

export const supplierPayments = pgTable(
  'supplier_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    /** Nullable after 019 migration — new rows use paymentMethodId instead. */
    financeAccountId: uuid('finance_account_id')
      .references(() => financeAccounts.id, { onDelete: 'restrict' }),
    /** New (019): which payment method wallet was debited. */
    paymentMethodId: uuid('payment_method_id')
      .references(() => shopPaymentMethods.id, { onDelete: 'restrict' }),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('supplier_payments_total_pos_chk', sql`${t.totalAmount} > 0`),
    index('ix_supplier_payments_supplier_time').on(t.supplierId, t.createdAt),
    index('ix_supplier_payments_shop_time').on(t.shopId, t.createdAt),
    index('ix_supplier_payments_finance_account').on(t.financeAccountId),
  ],
);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('DRAFT'),
    orderDate: date('order_date').notNull().default(sql`(now() AT TIME ZONE 'UTC')::date`),
    expectedDate: date('expected_date'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'purchase_orders_status_chk',
      sql`${t.status} IN ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED')`,
    ),
    index('ix_po_shop_status_date').on(t.shopId, t.status, t.orderDate),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    qtyOrdered: numeric('qty_ordered', { precision: 14, scale: 3 }).notNull(),
    qtyReceived: numeric('qty_received', { precision: 14, scale: 3 }).notNull().default('0'),
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull(),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    check('po_line_qty_ordered_chk', sql`${t.qtyOrdered} > 0`),
    check('po_line_qty_received_chk', sql`${t.qtyReceived} >= 0`),
    check('po_line_received_lte_ordered', sql`${t.qtyReceived} <= ${t.qtyOrdered}`),
    index('ix_po_lines_po').on(t.poId),
  ],
);

export const supplierPaymentPoAllocations = pgTable(
  'supplier_payment_po_allocations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => supplierPayments.id, { onDelete: 'cascade' }),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    check('supplier_pay_alloc_amount_pos_chk', sql`${t.amount} > 0`),
    uniqueIndex('ux_supplier_pay_alloc_payment_po').on(t.paymentId, t.poId),
    index('ix_supplier_pay_alloc_po').on(t.poId),
  ],
);

export const purchaseReturns = pgTable(
  'purchase_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    refPoId: uuid('ref_po_id').references(() => purchaseOrders.id, {
      onDelete: 'set null',
    }),
    returnDate: date('return_date')
      .notNull()
      .default(sql`(now() AT TIME ZONE 'UTC')::date`),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_purchase_returns_shop_time').on(t.shopId, t.createdAt),
    index('ix_purchase_returns_supplier_time').on(t.supplierId, t.createdAt),
  ],
);

export const purchaseReturnLines = pgTable(
  'purchase_return_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    poLineId: uuid('po_line_id').references(() => purchaseOrderLines.id, {
      onDelete: 'set null',
    }),
    locationId: uuid('location_id').references(() => stockLocations.id, {
      onDelete: 'set null',
    }),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull(),
    deviceUnitId: uuid('device_unit_id').references(() => deviceUnits.id, {
      onDelete: 'set null',
    }),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    check('purchase_return_lines_qty_chk', sql`${t.qty} > 0`),
    check('purchase_return_lines_unit_cost_chk', sql`${t.unitCost} >= 0`),
    index('ix_purchase_return_lines_return').on(t.returnId),
    index('ix_purchase_return_lines_product').on(t.productId),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customers_shop_id_phone').on(t.shopId, t.phone),
    index('ix_customers_shop_name').on(t.shopId, sql`lower(${t.name})`),
  ],
);

/** Storefront customer login (OTP/password) — one row per linked `customers` row when they sign up on the web. */
export const customerAccounts = pgTable(
  'customer_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    email: text('email'),
    phone: text('phone'),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('customer_accounts_shop_customer_uk').on(t.shopId, t.customerId),
    uniqueIndex('ux_customer_accounts_shop_email')
      .on(t.shopId, sql`lower(btrim(${t.email}))`)
      .where(sql`${t.email} IS NOT NULL AND btrim(${t.email}) <> ''`),
    uniqueIndex('ux_customer_accounts_shop_phone')
      .on(t.shopId, t.phone)
      .where(sql`${t.phone} IS NOT NULL AND btrim(${t.phone}) <> ''`),
    index('ix_customer_accounts_shop_customer').on(t.shopId, t.customerId),
  ],
);

export const customerLedgerEntries = pgTable(
  'customer_ledger_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    entryType: text('entry_type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'customer_ledger_entries_type_chk',
      sql`${t.entryType} IN ('SALE_DEBIT', 'PAYMENT', 'ADJUSTMENT', 'OPENING')`,
    ),
    index('ix_customer_ledger_customer_time').on(t.customerId, t.createdAt),
  ],
);

export const deliveryLocations = pgTable(
  'delivery_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    deliveryCharge: numeric('delivery_charge', { precision: 14, scale: 2 }).notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_delivery_locations_shop_active').on(t.shopId, t.isActive, t.sortOrder),
  ],
);

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    invoiceNo: text('invoice_no').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull().defaultNow(),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    paidTotal: numeric('paid_total', { precision: 14, scale: 2 }).notNull().default('0'),
    dueAmount: numeric('due_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Promised payment calendar date (Asia/Dhaka). Set when due_amount > 0 at checkout. */
    promisePayDate: date('promise_pay_date'),
    status: text('status').notNull().default('COMPLETED'),
    /** POS checkout vs future web storefront vs imports. */
    channel: text('channel').notNull().default('POS'),
    /** Delivery location for order fulfillment. */
    deliveryLocationId: uuid('delivery_location_id').references(() => deliveryLocations.id, {
      onDelete: 'set null',
    }),
    /** Delivery charge applied to order. */
    deliveryCharge: numeric('delivery_charge', { precision: 14, scale: 2 }).notNull().default('0'),
    cashierUserId: uuid('cashier_user_id').references(() => users.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'sales_status_chk',
      sql`${t.status} IN ('COMPLETED', 'VOID', 'REFUNDED', 'PARTIALLY_REFUNDED')`,
    ),
    check('sales_channel_chk', sql`${t.channel} IN ('POS', 'WEB', 'IMPORT')`),
    uniqueIndex('sales_shop_id_invoice_no').on(t.shopId, t.invoiceNo),
    uniqueIndex('ux_sales_shop_idempotency')
      .on(t.shopId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL AND btrim(${t.idempotencyKey}) <> ''`),
    index('ix_sales_shop_sold_at').on(t.shopId, t.soldAt),
    index('ix_sales_shop_channel_sold_at').on(t.shopId, t.channel, t.soldAt),
    index('ix_sales_shop_customer')
      .on(t.shopId, t.customerId)
      .where(sql`${t.customerId} IS NOT NULL`),
    index('ix_sales_shop_cashier_time').on(t.shopId, t.cashierUserId, t.soldAt),
    index('ix_sales_delivery_location').on(t.deliveryLocationId),
  ],
);

export const saleLines = pgTable(
  'sale_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    description: text('description'),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    discount: numeric('discount', { precision: 14, scale: 2 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
    cogsUnitCost: numeric('cogs_unit_cost', { precision: 14, scale: 2 }),
    deviceUnitId: uuid('device_unit_id').references(() => deviceUnits.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check('sale_lines_qty_chk', sql`${t.qty} > 0`),
    index('ix_sale_lines_sale').on(t.saleId),
    index('ix_sale_lines_product').on(t.productId),
  ],
);

/** Allocation of a quantity sale line to one or more batches (FEFO). */
export const saleLineBatchAllocations = pgTable(
  'sale_line_batch_allocations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    saleLineId: uuid('sale_line_id')
      .notNull()
      .references(() => saleLines.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => productBatches.id, { onDelete: 'restrict' }),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sale_line_batch_alloc_qty_chk', sql`${t.qty} > 0`),
    index('ix_sale_line_batch_alloc_line').on(t.saleLineId),
    index('ix_sale_line_batch_alloc_batch').on(t.batchId),
  ],
);

/** Per-shop POS tender types (owner-defined labels; not global BKASH/NAGAD enum). */
export const shopPaymentMethods = pgTable(
  'shop_payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ux_shop_payment_methods_shop_name').on(t.shopId, t.name),
    index('ix_shop_payment_methods_shop').on(t.shopId, t.sortOrder),
  ],
);

export const paymentMethodAdjustments = pgTable(
  'payment_method_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    paymentMethodId: uuid('payment_method_id')
      .notNull()
      .references(() => shopPaymentMethods.id, { onDelete: 'restrict' }),
    /** Always positive; direction controlled by type. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** 'IN' = money added to wallet; 'OUT' = money withdrawn. */
    type: text('type').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payment_method_adjustments_type_chk', sql`${t.type} IN ('IN','OUT')`),
    check('payment_method_adjustments_amount_pos_chk', sql`${t.amount} > 0`),
    index('ix_pm_adjustments_shop_method').on(t.shopId, t.paymentMethodId, t.createdAt),
  ],
);

export const salePayments = pgTable(
  'sale_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    paymentMethodId: uuid('payment_method_id')
      .notNull()
      .references(() => shopPaymentMethods.id, { onDelete: 'restrict' }),
    methodLabelSnapshot: text('method_label_snapshot'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    providerReference: text('provider_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sale_payments_amount_chk', sql`${t.amount} > 0`),
    index('ix_sale_payments_sale').on(t.saleId),
    index('ix_sale_payments_method').on(t.paymentMethodId),
  ],
);

export const posHolds = pgTable(
  'pos_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name'),
    payload: jsonb('payload').notNull().default({}),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_pos_holds_shop_created').on(t.shopId, t.createdAt)],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_refunds_shop_time').on(t.shopId, t.createdAt)],
);

export const refundLines = pgTable(
  'refund_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    saleLineId: uuid('sale_line_id')
      .notNull()
      .references(() => saleLines.id, { onDelete: 'restrict' }),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    restock: boolean('restock').notNull().default(true),
  },
  (t) => [
    check('refund_lines_qty_chk', sql`${t.qty} > 0`),
    index('ix_refund_lines_refund').on(t.refundId),
  ],
);

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_stock_adj_shop_time').on(t.shopId, t.createdAt)],
);

export const stockAdjustmentLines = pgTable(
  'stock_adjustment_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adjustmentId: uuid('adjustment_id')
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    qtyDelta: numeric('qty_delta', { precision: 14, scale: 3 }).notNull(),
    deviceUnitId: uuid('device_unit_id').references(() => deviceUnits.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('ix_stock_adj_lines_adj').on(t.adjustmentId)],
);

export const warrantyClaims = pgTable(
  'warranty_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    deviceUnitId: uuid('device_unit_id').references(() => deviceUnits.id, {
      onDelete: 'set null',
    }),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    reportedIssue: text('reported_issue'),
    physicalCondition: text('physical_condition'),
    includedAccessories: text('included_accessories'),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    vendorRmaNumber: text('vendor_rma_number'),
    replacementDeviceUnitId: uuid('replacement_device_unit_id').references(() => deviceUnits.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('RECEIVED'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    turnaroundDays: integer('turnaround_days'),
    termsSnapshot: text('terms_snapshot'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_warranty_shop_status').on(t.shopId, t.status, t.receivedAt)],
);

export const warrantyClaimEvents = pgTable(
  'warranty_claim_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => warrantyClaims.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_warranty_events_claim_time').on(t.claimId, t.createdAt)],
);

export const deviceEvents = pgTable(
  'device_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    deviceUnitId: uuid('device_unit_id')
      .notNull()
      .references(() => deviceUnits.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_device_events_unit_time').on(t.deviceUnitId, t.createdAt)],
);

export const financeAccounts = pgTable(
  'finance_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    provider: text('provider'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'finance_accounts_kind_chk',
      sql`${t.kind} IN ('CASH', 'BANK', 'MFS', 'OTHER')`,
    ),
    check(
      'finance_accounts_provider_chk',
      sql`${t.provider} IS NULL OR ${t.provider} IN ('BKASH', 'NAGAD', 'ROCKET')`,
    ),
    index('ix_finance_accounts_shop_sort').on(t.shopId, t.sortOrder),
  ],
);

export const financeTransfers = pgTable(
  'finance_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => financeAccounts.id, { onDelete: 'restrict' }),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => financeAccounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('finance_transfers_amount_chk', sql`${t.amount} > 0`),
    check('finance_transfers_diff_accounts_chk', sql`${t.fromAccountId} <> ${t.toAccountId}`),
    index('ix_finance_transfers_shop_time').on(t.shopId, t.createdAt),
  ],
);

export const financeAccountMovements = pgTable(
  'finance_account_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financeAccounts.id, { onDelete: 'restrict' }),
    delta: numeric('delta', { precision: 14, scale: 2 }).notNull(),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('finance_account_movements_delta_nonzero_chk', sql`${t.delta} <> 0`),
    check(
      'finance_account_movements_ref_table_chk',
      sql`${t.refTable} IS NULL OR ${t.refTable} IN ('supplier_payments','expenses','finance_transfers','opening_balance')`,
    ),
    index('ix_fin_acc_mov_shop_time').on(t.shopId, t.createdAt),
    index('ix_fin_acc_mov_account_time').on(t.accountId, t.createdAt),
  ],
);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('expense_categories_shop_id_name').on(t.shopId, t.name)],
);

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id, { onDelete: 'restrict' }),
    /** Nullable after 019 migration — new rows use paymentMethodId instead. */
    financeAccountId: uuid('finance_account_id')
      .references(() => financeAccounts.id, { onDelete: 'restrict' }),
    /** New (019): which payment method wallet was debited. */
    paymentMethodId: uuid('payment_method_id')
      .references(() => shopPaymentMethods.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    spentAt: timestamp('spent_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('expenses_amount_chk', sql`${t.amount} >= 0`),
    index('ix_expenses_shop_spent').on(t.shopId, t.spentAt),
    index('ix_expenses_finance_account').on(t.financeAccountId),
  ],
);

export const cashDrawerSessions = pgTable(
  'cash_drawer_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    openingFloat: numeric('opening_float', { precision: 14, scale: 2 }).notNull().default('0'),
    expectedCash: numeric('expected_cash', { precision: 14, scale: 2 }),
    countedCash: numeric('counted_cash', { precision: 14, scale: 2 }),
    variance: numeric('variance', { precision: 14, scale: 2 }),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_cash_drawer_shop_opened').on(t.shopId, t.openedAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    diff: jsonb('diff'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_audit_shop_time')
      .on(t.shopId, t.createdAt)
      .where(sql`${t.shopId} IS NOT NULL`),
    index('ix_audit_entity').on(t.entityType, t.entityId, t.createdAt),
  ],
);

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('notification_outbox_channel_chk', sql`${t.channel} IN ('SMS', 'EMAIL')`),
    check(
      'notification_outbox_status_chk',
      sql`${t.status} IN ('PENDING', 'SENDING', 'SENT', 'FAILED')`,
    ),
    index('ix_notification_outbox_pending')
      .on(t.shopId, t.createdAt)
      .where(sql`${t.status} IN ('PENDING', 'FAILED') AND ${t.attempts} < 10`),
  ],
);

/** Payload stored while waiting for email OTP (shop signup). */
export type ShopRegistrationChallengePayload = {
  shopName: string;
  shopSlug?: string | null;
  ownerName: string;
};

export const shopRegistrationChallenges = pgTable(
  'shop_registration_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    payload: jsonb('payload').$type<ShopRegistrationChallengePayload>().notNull(),
    otpHash: text('otp_hash').notNull(),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }).notNull(),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    maxOtpAttempts: integer('max_otp_attempts').notNull().default(5),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('shop_reg_chal_payload_obj_chk', sql`jsonb_typeof(${t.payload}) = 'object'`),
    index('ix_shop_reg_chal_email').on(t.email),
    index('ix_shop_reg_chal_created').on(t.createdAt),
  ],
);

/** Platform operators for internal-dashboard (OTP email login; no password column). */
export const internalDashboardUsers = pgTable(
  'internal_dashboard_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('internal_dashboard_users_email_lower_chk', sql`${t.email} = lower(${t.email})`),
    index('ix_internal_dashboard_users_active').on(t.isActive),
  ],
);

export const internalDashboardOtpChallenges = pgTable(
  'internal_dashboard_otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    otpHash: text('otp_hash').notNull(),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }).notNull(),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    maxOtpAttempts: integer('max_otp_attempts').notNull().default(5),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_internal_otp_email_created').on(t.email, t.createdAt)],
);

/** Customer storefront OTP challenges (phone/email). */
export const customerOtpChallenges = pgTable(
  'customer_otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    destination: text('destination').notNull(),
    otpHash: text('otp_hash').notNull(),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }).notNull(),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    maxOtpAttempts: integer('max_otp_attempts').notNull().default(5),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('customer_otp_channel_chk', sql`${t.channel} IN ('EMAIL', 'SMS')`),
    index('ix_customer_otp_shop_dest_created').on(t.shopId, t.destination, t.createdAt),
    index('ix_customer_otp_shop_created').on(t.shopId, t.createdAt),
  ],
);

export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    label: text('label'),
    recipientName: text('recipient_name'),
    phone: text('phone'),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city'),
    postalCode: text('postal_code'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_customer_addresses_shop_customer').on(t.shopId, t.customerId),
    index('ix_customer_addresses_default').on(t.shopId, t.customerId, t.isDefault),
  ],
);

/** Website bag checkout: lines stored until staff opens POS and completes sale (serials/batches there). */
export const storefrontFulfillmentOrders = pgTable(
  'storefront_fulfillment_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    shippingAddressId: uuid('shipping_address_id').references(() => customerAddresses.id, {
      onDelete: 'set null',
    }),
    deliveryLocationId: uuid('delivery_location_id').references(() => deliveryLocations.id, {
      onDelete: 'set null',
    }),
    deliveryCharge: numeric('delivery_charge', { precision: 14, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('PROCESSING'),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    publicRef: text('public_ref').notNull(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'storefront_fo_status_chk',
      sql`${t.status} IN ('PROCESSING','OUT_FOR_DELIVERY','SHIPPED','CANCELLED')`,
    ),
    uniqueIndex('ux_storefront_fo_shop_public_ref').on(t.shopId, t.publicRef),
    uniqueIndex('ux_storefront_fo_shop_idempotency')
      .on(t.shopId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL AND btrim(${t.idempotencyKey}) <> ''`),
    index('ix_storefront_fo_shop_customer_created').on(t.shopId, t.customerId, t.createdAt),
    index('ix_storefront_fo_shop_status_created').on(t.shopId, t.status, t.createdAt),
  ],
);

export const storefrontFulfillmentOrderLines = pgTable(
  'storefront_fulfillment_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => storefrontFulfillmentOrders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    check('storefront_fol_qty_chk', sql`${t.qty} > 0`),
    index('ix_storefront_fol_order').on(t.orderId),
  ],
);

export const shopSubscriptionPayments = pgTable(
  'shop_subscription_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('BDT'),
    periodDays: integer('period_days').notNull().default(30),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validThrough: timestamp('valid_through', { withTimezone: true }).notNull(),
    note: text('note'),
    recordedByInternalUserId: uuid('recorded_by_internal_user_id').references(
      () => internalDashboardUsers.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_shop_sub_pay_shop_created').on(t.shopId, t.createdAt)],
);
