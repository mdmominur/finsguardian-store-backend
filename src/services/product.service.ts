import { and, asc, count, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db } from '../db/client.js';
import {
  batchInventoryBalances,
  batchInventoryMovements,
  bundleItems,
  deviceEvents,
  inventoryBalances,
  inventoryMovements,
  deviceUnits,
  productBatches,
  products,
  productWebsiteProfiles,
  purchaseOrderLines,
  purchaseOrders,
  stockLocations,
  suppliers,
  uoms,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { getOrComputeShopCache } from '../lib/shop-cache.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { getDefaultLocationId, resolveLocationIdOrDefault } from './stock-location.service.js';
import { generateBatchCode } from './batch.service.js';

const barcodeSuffix = customAlphabet('0123456789', 12);

export type ProductRow = typeof products.$inferSelect;

export async function getQuantityOnHandAtLocation(
  shopId: string,
  productId: string,
  locationId: string,
  multiStockLocationEnabled: boolean,
) {
  const locId = await resolveLocationIdOrDefault(shopId, locationId, multiStockLocationEnabled);
  const [p] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  if (!p) throw AppError.notFound('Product not found');
  const [b] = await db
    .select({ quantity: inventoryBalances.quantity })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.shopId, shopId),
        eq(inventoryBalances.productId, productId),
        eq(inventoryBalances.locationId, locId),
      ),
    )
    .limit(1);
  return { quantity: String(b?.quantity ?? '0') };
}

/** Per-location on-hand for POS / pickers (quantity balances or serialized counts). */
export async function listProductStockByLocations(shopId: string, productId: string) {
  const [p] = await db
    .select({
      id: products.id,
      trackingMode: products.trackingMode,
    })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!p) throw AppError.notFound('Product not found');

  const defaultLocationId = await getDefaultLocationId(shopId);

  if (p.trackingMode === 'QUANTITY') {
    const rows = await db
      .select({
        locationId: inventoryBalances.locationId,
        locationName: stockLocations.name,
        isDefault: stockLocations.isDefault,
        quantity: inventoryBalances.quantity,
      })
      .from(inventoryBalances)
      .innerJoin(stockLocations, eq(stockLocations.id, inventoryBalances.locationId))
      .where(
        and(
          eq(inventoryBalances.shopId, shopId),
          eq(inventoryBalances.productId, productId),
          sql`${inventoryBalances.quantity}::numeric > 0`,
        ),
      )
      .orderBy(asc(stockLocations.name));

    return {
      trackingMode: p.trackingMode as 'QUANTITY',
      defaultLocationId,
      items: rows.map((r) => ({
        locationId: r.locationId,
        locationName: r.locationName,
        isDefault: r.isDefault,
        quantity: String(r.quantity),
      })),
    };
  }

  const rows = await db
    .select({
      locationId: deviceUnits.stockLocationId,
      locationName: stockLocations.name,
      isDefault: stockLocations.isDefault,
      cnt: count(),
    })
    .from(deviceUnits)
    .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
    .where(
      and(
        eq(deviceUnits.shopId, shopId),
        eq(deviceUnits.productId, productId),
        eq(deviceUnits.status, 'IN_STOCK'),
        eq(deviceUnits.blocklisted, false),
      ),
    )
    .groupBy(deviceUnits.stockLocationId, stockLocations.name, stockLocations.isDefault)
    .orderBy(asc(stockLocations.name));

  return {
    trackingMode: p.trackingMode as 'SERIALIZED',
    defaultLocationId,
    items: rows.map((r) => ({
      locationId: r.locationId,
      locationName: r.locationName ?? 'Unassigned',
      isDefault: r.isDefault ?? false,
      quantity: String(r.cnt ?? 0),
    })),
  };
}

export type StockStatusFilter = 'ALL' | 'EMPTY' | 'LOW' | 'LOW_OR_EMPTY' | 'IN_STOCK' | 'GOOD';

export async function listProducts(
  shopId: string,
  q: {
    search?: string;
    categoryId?: string;
    brandId?: string;
    trackingMode?: 'SERIALIZED' | 'QUANTITY';
    active?: boolean;
    /** When true: serialized products (always IMEI-tracked) OR quantity products with inventory_tracked. */
    inventoryTracked?: boolean;
    /** Filter by stock level state (EMPTY, LOW, LOW_OR_EMPTY, IN_STOCK, GOOD). */
    stockStatus?: StockStatusFilter;
    limit: number;
    offset: number;
    /** When multi-location is on, on-hand figures use this stock location (POS picker). */
    stockLocationId?: string;
    /** Sum quantity across locations / count serialized units shop-wide (e.g. purchase return picker). */
    stockScope?: 'default' | 'all_locations';
    /** Products that appear on any non-cancelled PO for this supplier (purchase return picker). */
    supplierId?: string;
    /** Narrow to products on this PO’s lines (must belong to shop; optional cross-check with supplierId). */
    purchaseOrderId?: string;
  },
) {
  const conditions = [eq(products.shopId, shopId)];

  const [defaultLocId, multiLoc] = await Promise.all([
    getDefaultLocationId(shopId),
    isMultiStockLocationEnabled(shopId),
  ]);
  const effectiveLocId = await resolveLocationIdOrDefault(shopId, q.stockLocationId, multiLoc);
  const scopeAll = q.stockScope === 'all_locations';

  let productIdFilter: string[] | null = null;

  if (q.purchaseOrderId) {
    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, q.purchaseOrderId), eq(purchaseOrders.shopId, shopId)))
      .limit(1);
    if (!po) throw AppError.notFound('Purchase order not found');
    if (po.status !== 'COMPLETED') {
      throw AppError.badRequest(
        'Products can only be filtered by a fully received (completed) purchase order',
      );
    }
    if (q.supplierId && po.supplierId !== q.supplierId) {
      throw AppError.badRequest('This purchase order does not belong to the selected supplier');
    }
    const lineRows = await db
      .select({ productId: purchaseOrderLines.productId })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, q.purchaseOrderId))
      .groupBy(purchaseOrderLines.productId);
    productIdFilter = lineRows.map((r) => r.productId);
  } else if (q.supplierId) {
    const [sup] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, q.supplierId), eq(suppliers.shopId, shopId)))
      .limit(1);
    if (!sup) throw AppError.notFound('Supplier not found');
    const lineRows = await db
      .select({ productId: purchaseOrderLines.productId })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
      .where(
        and(
          eq(purchaseOrders.shopId, shopId),
          eq(purchaseOrders.supplierId, q.supplierId),
          eq(purchaseOrders.status, 'COMPLETED'),
        ),
      )
      .groupBy(purchaseOrderLines.productId);
    productIdFilter = lineRows.map((r) => r.productId);
  }

  if (productIdFilter !== null && productIdFilter.length === 0) {
    return [];
  }
  if (productIdFilter !== null) {
    conditions.push(inArray(products.id, productIdFilter));
  }

  if (q.active !== undefined) conditions.push(eq(products.active, q.active));
  if (q.categoryId) conditions.push(eq(products.categoryId, q.categoryId));
  if (q.brandId) conditions.push(eq(products.brandId, q.brandId));
  if (q.trackingMode) conditions.push(eq(products.trackingMode, q.trackingMode));
  if (q.inventoryTracked === true) {
    conditions.push(
      or(eq(products.trackingMode, 'SERIALIZED'), eq(products.inventoryTracked, true))!,
    );
  }

  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    conditions.push(
      or(ilike(products.name, s), ilike(products.sku, s), ilike(products.barcode, s))!,
    );
  }

  if (q.stockStatus && q.stockStatus !== 'ALL') {
    const serialLocFilter =
      !scopeAll && multiLoc
        ? effectiveLocId === defaultLocId
          ? sql`and (du.stock_location_id = ${effectiveLocId}::uuid or du.stock_location_id is null)`
          : sql`and du.stock_location_id = ${effectiveLocId}::uuid`
        : sql``;

    const qtySubquery = scopeAll
      ? sql`coalesce((select sum(ib.quantity::numeric) from inventory_balances ib where ib.shop_id = "products"."shop_id" and ib.product_id = "products"."id"), 0)`
      : sql`coalesce((select ib.quantity::numeric from inventory_balances ib where ib.shop_id = "products"."shop_id" and ib.product_id = "products"."id" and ib.location_id = ${effectiveLocId}::uuid), 0)`;

    const serialSubquery = sql`coalesce((select count(*)::numeric from device_units du where du.shop_id = "products"."shop_id" and du.product_id = "products"."id" and du.status = 'IN_STOCK' and du.blocklisted = false ${serialLocFilter}), 0)`;

    const onHandExpr = sql`(case when "products"."tracking_mode" = 'SERIALIZED' then ${serialSubquery} else ${qtySubquery} end)`;
    const minStockExpr = sql`greatest(coalesce("products"."min_stock_level"::numeric, 0), 0)`;

    conditions.push(eq(products.isBundle, false));
    conditions.push(
      or(eq(products.trackingMode, 'SERIALIZED'), eq(products.inventoryTracked, true))!,
    );

    if (q.stockStatus === 'EMPTY') {
      conditions.push(sql`${onHandExpr} <= 0`);
    } else if (q.stockStatus === 'LOW') {
      conditions.push(sql`${onHandExpr} > 0 and ${onHandExpr} <= ${minStockExpr}`);
    } else if (q.stockStatus === 'LOW_OR_EMPTY') {
      conditions.push(sql`${onHandExpr} <= ${minStockExpr}`);
    } else if (q.stockStatus === 'IN_STOCK') {
      conditions.push(sql`${onHandExpr} > 0`);
    } else if (q.stockStatus === 'GOOD') {
      conditions.push(sql`${onHandExpr} > 0 and ${onHandExpr} > ${minStockExpr}`);
    }
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select()
    .from(products)
    .where(whereClause)
    .orderBy(products.name)
    .limit(q.limit)
    .offset(q.offset);

  if (rows.length === 0) {
    return [];
  }

  const quantityProductIds = rows
    .filter((p) => p.trackingMode === 'QUANTITY')
    .map((p) => p.id);
  const serializedProductIds = rows
    .filter((p) => p.trackingMode !== 'QUANTITY')
    .map((p) => p.id);
  const allPageProductIds = rows.map((p) => p.id);
  const uomIds = [...new Set(rows.map((p) => p.uomId).filter((id): id is string => Boolean(id)))];

  const [qtyRows, serialRows, poAvgRows, uomRows] = await Promise.all([
    quantityProductIds.length === 0
      ? Promise.resolve([] as Array<{ productId: string; quantity: string }>)
      : scopeAll
        ? db
            .select({
              productId: inventoryBalances.productId,
              quantity: sql<string>`coalesce(sum(${inventoryBalances.quantity}::numeric), 0)::text`,
            })
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                inArray(inventoryBalances.productId, quantityProductIds),
              ),
            )
            .groupBy(inventoryBalances.productId)
        : db
            .select({
              productId: inventoryBalances.productId,
              quantity: inventoryBalances.quantity,
            })
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                eq(inventoryBalances.locationId, effectiveLocId),
                inArray(inventoryBalances.productId, quantityProductIds),
              ),
            ),

    serializedProductIds.length === 0
      ? Promise.resolve(
          [] as Array<{
            productId: string;
            n: number;
            costedCount: number;
            poCostSum: string;
          }>,
        )
      : (() => {
          let duWhere = and(
            eq(deviceUnits.shopId, shopId),
            inArray(deviceUnits.productId, serializedProductIds),
            eq(deviceUnits.status, 'IN_STOCK'),
            eq(deviceUnits.blocklisted, false),
          );
          if (!scopeAll && multiLoc) {
            const atLocation = eq(deviceUnits.stockLocationId, effectiveLocId);
            if (effectiveLocId === defaultLocId) {
              duWhere = and(duWhere, or(atLocation, isNull(deviceUnits.stockLocationId))!);
            } else {
              duWhere = and(duWhere, atLocation);
            }
          }
          return db
            .select({
              productId: deviceUnits.productId,
              n: count(),
              costedCount: sql<number>`count(case when coalesce(${purchaseOrderLines.unitCost}::numeric, 0) > 0 then 1 else null end)::int`,
              poCostSum: sql<string>`coalesce(sum(case when coalesce(${purchaseOrderLines.unitCost}::numeric, 0) > 0 then ${purchaseOrderLines.unitCost}::numeric else 0 end), 0)::text`,
            })
            .from(deviceUnits)
            .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, deviceUnits.receivedPoLineId))
            .where(duWhere)
            .groupBy(deviceUnits.productId);
        })(),

    allPageProductIds.length === 0
      ? Promise.resolve([] as Array<{ productId: string; avgCost: string }>)
      : db
          .select({
            productId: purchaseOrderLines.productId,
            avgCost: sql<string>`(
              case
                when sum(${purchaseOrderLines.qtyReceived}::numeric) > 0
                  then sum(${purchaseOrderLines.qtyReceived}::numeric * greatest(${purchaseOrderLines.unitCost}::numeric, 0))
                       / sum(${purchaseOrderLines.qtyReceived}::numeric)
                else avg(greatest(${purchaseOrderLines.unitCost}::numeric, 0))
              end
            )::text`,
          })
          .from(purchaseOrderLines)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
          .where(
            and(
              eq(purchaseOrders.shopId, shopId),
              ne(purchaseOrders.status, 'CANCELLED'),
              inArray(purchaseOrderLines.productId, allPageProductIds),
              sql`${purchaseOrderLines.unitCost}::numeric > 0`,
            ),
          )
          .groupBy(purchaseOrderLines.productId),

    uomIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; name: string; symbol: string | null }>)
      : db
          .select({
            id: uoms.id,
            name: uoms.name,
            symbol: uoms.symbol,
          })
          .from(uoms)
          .where(and(eq(uoms.shopId, shopId), inArray(uoms.id, uomIds))),
  ]);

  const stockByProductId = new Map<string, string>();
  for (const r of qtyRows) {
    stockByProductId.set(r.productId, String(r.quantity ?? '0'));
  }
  const serialMetaByProductId = new Map<
    string,
    { n: number; costedCount: number; poCostSum: number }
  >();
  for (const r of serialRows) {
    stockByProductId.set(r.productId, String(r.n ?? 0));
    serialMetaByProductId.set(r.productId, {
      n: Number(r.n ?? 0),
      costedCount: Number(r.costedCount ?? 0),
      poCostSum: Number(r.poCostSum ?? 0),
    });
  }
  const poAvgByProductId = new Map<string, number>();
  for (const r of poAvgRows) {
    const v = Number(r.avgCost ?? 0);
    if (Number.isFinite(v) && v > 0) poAvgByProductId.set(r.productId, v);
  }
  const uomById = new Map<string, { name: string; symbol: string | null }>();
  for (const u of uomRows) {
    uomById.set(u.id, { name: u.name, symbol: u.symbol });
  }

  return rows.map((p) => {
    const quantityOnHand = stockByProductId.get(p.id) ?? '0';
    const min = Number(p.minStockLevel || 0);
    const qNum = Math.max(0, Number(quantityOnHand) || 0);
    let stockBadge: 'EMPTY' | 'LOW' | 'GOOD' = 'GOOD';
    if (qNum <= 0) stockBadge = 'EMPTY';
    else if (qNum <= min) stockBadge = 'LOW';

    const bookCost = Math.max(0, Number(p.unitCost) || 0);
    const poFallbackCost = poAvgByProductId.get(p.id) ?? 0;
    const baseUnitCost = bookCost > 0 ? bookCost : poFallbackCost;

    let stockPurchaseValueNum = 0;
    let effectiveUnitCostNum = baseUnitCost;

    if (!p.isBundle) {
      if (p.trackingMode === 'SERIALIZED') {
        const sm = serialMetaByProductId.get(p.id);
        const poSum = sm?.poCostSum ?? 0;
        const costedCnt = sm?.costedCount ?? 0;
        const uncostedUnits = Math.max(0, qNum - costedCnt);
        stockPurchaseValueNum = poSum + uncostedUnits * baseUnitCost;
        effectiveUnitCostNum = qNum > 0 ? stockPurchaseValueNum / qNum : baseUnitCost;
      } else if (p.inventoryTracked !== false) {
        stockPurchaseValueNum = qNum * baseUnitCost;
      }
    }

    const listPriceNum = Math.max(0, Number(p.listPrice) || 0);
    const estimatedSalesValueNum =
      !p.isBundle && (p.trackingMode === 'SERIALIZED' || p.inventoryTracked !== false)
        ? qNum * listPriceNum
        : 0;

    const uom = p.uomId ? uomById.get(p.uomId) : undefined;

    return {
      ...p,
      uomName: uom?.name ?? null,
      uomSymbol: uom?.symbol ?? null,
      quantityOnHand,
      stockBadge,
      effectiveUnitCost: effectiveUnitCostNum.toFixed(2),
      stockPurchaseValue: stockPurchaseValueNum.toFixed(2),
      estimatedSalesValue: estimatedSalesValueNum.toFixed(2),
    };
  });
}

export type InventorySummaryStats = {
  totalItems: number;
  bundleCount: number;
  inStockItems: number;
  lowStockItems: number;
  outOfStockItems: number;
  totalQuantity: string;
  quantityTrackedTotal: string;
  serializedUnitsTotal: number;
  totalPurchaseValue: string | null;
  estimatedSalesValue: string;
  estimatedProfit: string | null;
  estimatedMarginPercent: string | null;
  uncostedInStockItems: number | null;
  unpricedInStockItems: number;
};

function formatCleanQty(val: string | number): string {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Single-query inventory valuation & summary across all matching products.
 * Handles QUANTITY + SERIALIZED (per-unit PO line cost + product unitCost + PO average fallback),
 * excludes virtual bundles from physical stock sums, guards against negative numbers,
 * and caches per-shop for 60s with automatic mutation invalidation.
 */
export async function getInventorySummary(
  shopId: string,
  q: {
    search?: string;
    categoryId?: string;
    brandId?: string;
    trackingMode?: 'SERIALIZED' | 'QUANTITY';
    active?: boolean;
    inventoryTracked?: boolean;
    stockStatus?: StockStatusFilter;
    stockLocationId?: string;
    stockScope?: 'default' | 'all_locations';
  },
): Promise<InventorySummaryStats> {
  const cacheKey = `inventory:summary:${JSON.stringify({
    search: q.search?.trim() || '',
    categoryId: q.categoryId || '',
    brandId: q.brandId || '',
    trackingMode: q.trackingMode || '',
    active: q.active ?? true,
    inventoryTracked: q.inventoryTracked ?? null,
    stockStatus: q.stockStatus || 'ALL',
    stockLocationId: q.stockLocationId || '',
    stockScope: q.stockScope || 'default',
  })}`;

  return getOrComputeShopCache(shopId, cacheKey, 60_000, async () => {
    const [defaultLocId, multiLoc] = await Promise.all([
      getDefaultLocationId(shopId),
      isMultiStockLocationEnabled(shopId),
    ]);
    const effectiveLocId = await resolveLocationIdOrDefault(shopId, q.stockLocationId, multiLoc);
    const scopeAll = q.stockScope === 'all_locations';

    const activeFilter = q.active !== undefined ? sql`and p.active = ${q.active}` : sql``;
    const categoryFilter = q.categoryId ? sql`and p.category_id = ${q.categoryId}::uuid` : sql``;
    const brandFilter = q.brandId ? sql`and p.brand_id = ${q.brandId}::uuid` : sql``;
    const trackingFilter = q.trackingMode ? sql`and p.tracking_mode = ${q.trackingMode}` : sql``;
    const inventoryTrackedFilter =
      q.inventoryTracked === true
        ? sql`and (p.tracking_mode = 'SERIALIZED' or p.inventory_tracked = true)`
        : q.inventoryTracked === false
          ? sql`and p.tracking_mode = 'QUANTITY' and p.inventory_tracked = false`
          : sql``;

    const searchTrimmed = q.search?.trim();
    const searchPattern = searchTrimmed ? `%${searchTrimmed}%` : '';
    const searchFilter = searchTrimmed
      ? sql`and (p.name ilike ${searchPattern} or p.sku ilike ${searchPattern} or coalesce(p.barcode, '') ilike ${searchPattern})`
      : sql``;

    const serialLocationFilter =
      !scopeAll && multiLoc
        ? effectiveLocId === defaultLocId
          ? sql`and (du.stock_location_id = ${effectiveLocId}::uuid or du.stock_location_id is null)`
          : sql`and du.stock_location_id = ${effectiveLocId}::uuid`
        : sql``;

    const qtyStockCte = scopeAll
      ? sql`
          select
            ib.product_id,
            greatest(coalesce(sum(ib.quantity::numeric), 0), 0) as qty
          from inventory_balances ib
          where ib.shop_id = ${shopId}::uuid
          group by ib.product_id
        `
      : sql`
          select
            ib.product_id,
            greatest(coalesce(ib.quantity::numeric, 0), 0) as qty
          from inventory_balances ib
          where ib.shop_id = ${shopId}::uuid
            and ib.location_id = ${effectiveLocId}::uuid
        `;

    const statusCondSql =
      q.stockStatus === 'EMPTY'
        ? sql`and not is_bundle and on_hand <= 0`
        : q.stockStatus === 'LOW'
          ? sql`and not is_bundle and on_hand > 0 and on_hand <= min_stock`
          : q.stockStatus === 'LOW_OR_EMPTY'
            ? sql`and not is_bundle and on_hand <= min_stock`
            : q.stockStatus === 'IN_STOCK'
              ? sql`and not is_bundle and on_hand > 0`
              : q.stockStatus === 'GOOD'
                ? sql`and not is_bundle and on_hand > 0 and on_hand > min_stock`
                : sql`and not is_bundle`;

    const res = (await db.execute(sql`
      with filtered_products as (
        select
          p.id,
          p.tracking_mode,
          p.inventory_tracked,
          p.is_bundle,
          greatest(coalesce(p.min_stock_level::numeric, 0), 0) as min_stock,
          greatest(coalesce(p.unit_cost::numeric, 0), 0) as book_cost,
          greatest(coalesce(p.list_price::numeric, 0), 0) as list_price
        from products p
        where p.shop_id = ${shopId}::uuid
          ${activeFilter}
          ${categoryFilter}
          ${brandFilter}
          ${trackingFilter}
          ${inventoryTrackedFilter}
          ${searchFilter}
      ),
      qty_stock as (
        ${qtyStockCte}
      ),
      serial_stock as (
        select
          du.product_id,
          count(*)::numeric as cnt,
          count(*) filter (where coalesce(pol.unit_cost::numeric, 0) > 0)::numeric as costed_cnt,
          coalesce(
            sum(
              case
                when coalesce(pol.unit_cost::numeric, 0) > 0 then pol.unit_cost::numeric
                else 0
              end
            ),
            0
          ) as po_cost_sum
        from device_units du
        inner join filtered_products fp on fp.id = du.product_id
        left join purchase_order_lines pol on pol.id = du.received_po_line_id
        where du.shop_id = ${shopId}::uuid
          and du.status = 'IN_STOCK'
          and du.blocklisted = false
          ${serialLocationFilter}
        group by du.product_id
      ),
      po_avg_cost as (
        select
          pol.product_id,
          case
            when sum(pol.qty_received::numeric) > 0
              then sum(pol.qty_received::numeric * greatest(pol.unit_cost::numeric, 0))
                   / sum(pol.qty_received::numeric)
            else avg(greatest(pol.unit_cost::numeric, 0))
          end as avg_cost
        from purchase_order_lines pol
        inner join purchase_orders po on po.id = pol.po_id
        inner join filtered_products fp on fp.id = pol.product_id
        where po.shop_id = ${shopId}::uuid
          and po.status <> 'CANCELLED'
          and pol.unit_cost::numeric > 0
        group by pol.product_id
      ),
      product_rollup as (
        select
          fp.id,
          fp.tracking_mode,
          fp.is_bundle,
          fp.min_stock,
          fp.list_price,
          case
            when fp.is_bundle then 0::numeric
            when fp.tracking_mode = 'SERIALIZED' then coalesce(ss.cnt, 0)
            when fp.inventory_tracked = false then 0::numeric
            else coalesce(qs.qty, 0)
          end as on_hand,
          case
            when fp.is_bundle then 0::numeric
            when fp.tracking_mode = 'SERIALIZED' then
              coalesce(ss.po_cost_sum, 0)
              + greatest(coalesce(ss.cnt, 0) - coalesce(ss.costed_cnt, 0), 0)
                * coalesce(nullif(fp.book_cost, 0), coalesce(pac.avg_cost, 0))
            when fp.inventory_tracked = false then 0::numeric
            else
              coalesce(qs.qty, 0) * coalesce(nullif(fp.book_cost, 0), coalesce(pac.avg_cost, 0))
          end as stock_purchase_val
        from filtered_products fp
        left join qty_stock qs on qs.product_id = fp.id
        left join serial_stock ss on ss.product_id = fp.id
        left join po_avg_cost pac on pac.product_id = fp.id
      )
      select
        count(*) filter (where true ${statusCondSql})::int as "totalItems",
        count(*) filter (where is_bundle)::int as "bundleCount",
        count(*) filter (where not is_bundle and on_hand > 0)::int as "inStockItems",
        count(*) filter (where not is_bundle and on_hand > 0 and on_hand <= min_stock)::int as "lowStockItems",
        count(*) filter (where not is_bundle and on_hand <= 0)::int as "outOfStockItems",
        coalesce(sum(on_hand) filter (where true ${statusCondSql}), 0)::text as "totalQuantity",
        coalesce(sum(on_hand) filter (where tracking_mode = 'QUANTITY' ${statusCondSql}), 0)::text as "quantityTrackedTotal",
        coalesce(sum(on_hand) filter (where tracking_mode = 'SERIALIZED' ${statusCondSql}), 0)::int as "serializedUnitsTotal",
        round(coalesce(sum(stock_purchase_val) filter (where on_hand > 0 ${statusCondSql}), 0), 2)::text as "totalPurchaseValue",
        round(coalesce(sum(on_hand * list_price) filter (where on_hand > 0 ${statusCondSql}), 0), 2)::text as "estimatedSalesValue",
        count(*) filter (where on_hand > 0 and stock_purchase_val <= 0 ${statusCondSql})::int as "uncostedInStockItems",
        count(*) filter (where on_hand > 0 and list_price <= 0 ${statusCondSql})::int as "unpricedInStockItems"
      from product_rollup
    `)) as unknown as {
      rows: Array<{
        totalItems: number;
        bundleCount: number;
        inStockItems: number;
        lowStockItems: number;
        outOfStockItems: number;
        totalQuantity: string;
        quantityTrackedTotal: string;
        serializedUnitsTotal: number;
        totalPurchaseValue: string;
        estimatedSalesValue: string;
        uncostedInStockItems: number;
        unpricedInStockItems: number;
      }>;
    };

    const row = res.rows[0];
    const purchaseVal = Number(row?.totalPurchaseValue ?? 0);
    const salesVal = Number(row?.estimatedSalesValue ?? 0);
    const profitVal = salesVal - purchaseVal;
    const marginPct = salesVal > 0 ? ((profitVal / salesVal) * 100).toFixed(1) : null;

    return {
      totalItems: Number(row?.totalItems ?? 0),
      bundleCount: Number(row?.bundleCount ?? 0),
      inStockItems: Number(row?.inStockItems ?? 0),
      lowStockItems: Number(row?.lowStockItems ?? 0),
      outOfStockItems: Number(row?.outOfStockItems ?? 0),
      totalQuantity: formatCleanQty(row?.totalQuantity ?? '0'),
      quantityTrackedTotal: formatCleanQty(row?.quantityTrackedTotal ?? '0'),
      serializedUnitsTotal: Number(row?.serializedUnitsTotal ?? 0),
      totalPurchaseValue: purchaseVal.toFixed(2),
      estimatedSalesValue: salesVal.toFixed(2),
      estimatedProfit: profitVal.toFixed(2),
      estimatedMarginPercent: marginPct,
      uncostedInStockItems: Number(row?.uncostedInStockItems ?? 0),
      unpricedInStockItems: Number(row?.unpricedInStockItems ?? 0),
    };
  });
}

function generateBarcode(): string {
  return `8${barcodeSuffix()}`;
}

/** Uppercase slug from product name for SKU (A–Z, 0–9, hyphens). */
export function slugifySkuBase(name: string): string {
  const s = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return s || `ITEM-${Date.now()}`;
}

export async function isSkuTaken(
  shopId: string,
  sku: string,
  excludeProductId?: string,
): Promise<boolean> {
  const trimmed = sku.trim();
  if (!trimmed) return false;
  const cond = [
    eq(products.shopId, shopId),
    sql`lower(${products.sku}) = lower(${trimmed})`,
  ];
  if (excludeProductId) cond.push(ne(products.id, excludeProductId));
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(...cond))
    .limit(1);
  return !!row;
}

/** Base slug from name; if taken, append timestamp (per shop, case-insensitive SKU). */
export async function suggestUniqueSkuFromName(
  shopId: string,
  name: string,
  excludeProductId?: string,
): Promise<string> {
  const base = slugifySkuBase(name);
  if (!(await isSkuTaken(shopId, base, excludeProductId))) return base;
  const withTs = `${base}-${Date.now()}`.slice(0, 120);
  if (!(await isSkuTaken(shopId, withTs, excludeProductId))) return withTs;
  return `${base}-${Date.now()}-2`.slice(0, 120);
}

export async function createProduct(
  shopId: string,
  input: {
    sku: string;
    name: string;
    barcode?: string | null;
    categoryId?: string | null;
    brandId?: string | null;
    uomId?: string | null;
    trackingMode: 'SERIALIZED' | 'QUANTITY';
    costMethod?: 'MOVING_AVG' | 'FIFO';
    unitCost?: string;
    listPrice?: string;
    minStockLevel?: number;
    isBundle?: boolean;
    active?: boolean;
    metadata?: Record<string, unknown>;
    website?: {
      visible?: boolean;
      slug?: string | null;
      shortDescription?: string | null;
      longDescription?: string | null;
    };
    autoBarcode?: boolean;
    /** Ignored for SERIALIZED (always tracked by device). */
    inventoryTracked?: boolean;
    openingQty?: number;
    openingSerials?: string[];
    openingBatches?: Array<{
      qty: string;
      manufacturedAt?: string | null;
      expiresAt?: string | null;
      supplierLotCode?: string | null;
      batchCode?: string | null;
    }>;
    /** QUANTITY only: enable FEFO batch tracking. */
    batchTrackingEnabled?: boolean;
    /** When batch tracking enabled, require manufactured/expires dates for incoming batches. */
    batchDatesRequired?: boolean;
    createdByUserId?: string | null;
  },
) {
  const openingQty = Math.max(0, Number(input.openingQty ?? 0) || 0);
  const openingSerials = (input.openingSerials ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const openingBatches = input.openingBatches ?? [];

  if (input.trackingMode === 'SERIALIZED') {
    if (openingQty > 0 && openingSerials.length !== openingQty) {
      throw AppError.badRequest(
        `Opening serial count (${openingSerials.length}) must match opening quantity (${openingQty})`,
      );
    }
    const dup = new Set<string>();
    for (const serial of openingSerials) {
      if (dup.has(serial)) {
        throw AppError.badRequest(`Duplicate serial in opening list: ${serial}`);
      }
      dup.add(serial);
    }
  }

  let barcode = input.barcode?.trim() || null;
  if (!barcode && input.autoBarcode !== false) {
    barcode = generateBarcode();
  }

  const inventoryTracked =
    input.trackingMode === 'SERIALIZED' ? true : (input.inventoryTracked ?? true);

  const batchTrackingEnabled =
    input.trackingMode === 'QUANTITY' ? (input.batchTrackingEnabled ?? false) : false;
  const batchDatesRequired =
    batchTrackingEnabled ? (input.batchDatesRequired ?? true) : false;

  if (input.trackingMode === 'QUANTITY') {
    if (openingQty > 0 && batchTrackingEnabled) {
      if (openingBatches.length === 0) {
        throw AppError.badRequest('Opening batches are required when batch tracking is enabled');
      }
      const sum = openingBatches.reduce((s, b) => s + Number(b.qty), 0);
      if (!Number.isFinite(sum) || Math.abs(sum - openingQty) > 1e-6) {
        throw AppError.badRequest('Opening batch quantities must sum to openingQty', {
          openingQty,
          openingBatchQtySum: sum,
        });
      }
      if (batchDatesRequired) {
        for (const b of openingBatches) {
          if (!b.manufacturedAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt)) {
            throw AppError.badRequest('manufacturedAt is required (YYYY-MM-DD) for opening batches');
          }
          if (!b.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt)) {
            throw AppError.badRequest('expiresAt is required (YYYY-MM-DD) for opening batches');
          }
        }
      }
    }
  }

  const metadata: Record<string, unknown> = input.metadata ?? {};
  if (input.website) {
    const nextWebsite: Record<string, unknown> =
      metadata.website && typeof metadata.website === 'object' && !Array.isArray(metadata.website)
        ? { ...(metadata.website as Record<string, unknown>) }
        : {};
    if (input.website.visible !== undefined) nextWebsite.visible = input.website.visible;
    if (input.website.slug !== undefined) nextWebsite.slug = input.website.slug;
    if (input.website.shortDescription !== undefined)
      nextWebsite.shortDescription = input.website.shortDescription;
    if (input.website.longDescription !== undefined)
      nextWebsite.longDescription = input.website.longDescription;
    metadata.website = nextWebsite;
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(products)
      .values({
        shopId,
        sku: input.sku.trim(),
        name: input.name.trim(),
        barcode,
        categoryId: input.categoryId ?? null,
        brandId: input.brandId ?? null,
        uomId: input.uomId ?? null,
        trackingMode: input.trackingMode,
        costMethod: input.costMethod ?? 'MOVING_AVG',
        unitCost: input.unitCost ?? '0',
        listPrice: input.listPrice ?? '0',
        minStockLevel: String(input.minStockLevel ?? 0),
        inventoryTracked,
        batchTrackingEnabled,
        batchDatesRequired,
        isBundle: input.isBundle ?? false,
        active: input.active ?? true,
        metadata,
      })
      .returning();

    if (!row) throw AppError.conflict('Could not create product');

    if (input.website) {
      await tx
        .insert(productWebsiteProfiles)
        .values({
          shopId,
          productId: row.id,
          visible: input.website.visible ?? false,
          seoSlug: input.website.slug || null,
          shortDescription: input.website.shortDescription || null,
          longDescription: input.website.longDescription || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    if (input.trackingMode === 'SERIALIZED' && openingSerials.length > 0) {
      for (const serial of openingSerials) {
        const [du] = await tx
          .insert(deviceUnits)
          .values({
            shopId,
            productId: row.id,
            serial,
            imei1: null,
            imei2: null,
            status: 'IN_STOCK',
            receivedPoLineId: null,
          })
          .returning();

        await tx.insert(deviceEvents).values({
          deviceUnitId: du!.id,
          eventType: 'CREATED_WITH_PRODUCT',
          refTable: 'products',
          refId: row.id,
          payload: {},
          createdBy: input.createdByUserId ?? null,
        });
      }
    }

    if (input.trackingMode === 'QUANTITY' && openingQty > 0 && inventoryTracked !== false) {
      const defaultLocId = await getDefaultLocationId(shopId);

      // Aggregate balance
      await tx
        .insert(inventoryBalances)
        .values({
          shopId,
          productId: row.id,
          locationId: defaultLocId,
          quantity: String(openingQty),
        })
        .onConflictDoUpdate({
          target: [inventoryBalances.shopId, inventoryBalances.productId, inventoryBalances.locationId],
          set: {
            quantity: sql`${inventoryBalances.quantity}::numeric + ${String(openingQty)}::numeric`,
            updatedAt: new Date(),
          },
        });

      await tx.insert(inventoryMovements).values({
        shopId,
        productId: row.id,
        locationId: defaultLocId,
        quantityDelta: String(openingQty),
        movementType: 'ADJUSTMENT',
        refTable: 'products',
        refId: row.id,
        unitCost: row.unitCost,
        createdBy: input.createdByUserId ?? null,
      });

      if (batchTrackingEnabled) {
        for (const b of openingBatches) {
          const bQty = Number(b.qty);
          if (!Number.isFinite(bQty) || bQty <= 0) continue;

          const batchCode = (b.batchCode?.trim() || generateBatchCode()).trim();
          const manufacturedAt =
            b.manufacturedAt && /^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt) ? b.manufacturedAt : null;
          const expiresAt =
            b.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) ? b.expiresAt : null;

          const [created] = await tx
            .insert(productBatches)
            .values({
              shopId,
              productId: row.id,
              batchCode,
              supplierLotCode: b.supplierLotCode?.trim() || null,
              manufacturedAt,
              expiresAt,
            })
            .onConflictDoNothing({
              target: [productBatches.shopId, productBatches.productId, productBatches.batchCode],
            })
            .returning();

          const batchRow =
            created ??
            (await tx
              .select()
              .from(productBatches)
              .where(
                and(
                  eq(productBatches.shopId, shopId),
                  eq(productBatches.productId, row.id),
                  eq(productBatches.batchCode, batchCode),
                ),
              )
              .limit(1))[0];
          if (!batchRow) throw AppError.conflict('Could not create or load opening batch');

          await tx
            .insert(batchInventoryBalances)
            .values({
              shopId,
              batchId: batchRow.id,
              locationId: defaultLocId,
              quantity: String(bQty),
            })
            .onConflictDoUpdate({
              target: [batchInventoryBalances.shopId, batchInventoryBalances.batchId, batchInventoryBalances.locationId],
              set: {
                quantity: sql`${batchInventoryBalances.quantity}::numeric + ${String(bQty)}::numeric`,
                updatedAt: new Date(),
              },
            });

          await tx.insert(batchInventoryMovements).values({
            shopId,
            batchId: batchRow.id,
            productId: row.id,
            locationId: defaultLocId,
            quantityDelta: String(bQty),
            movementType: 'ADJUSTMENT',
            refTable: 'products',
            refId: row.id,
            createdBy: input.createdByUserId ?? null,
          });
        }
      }
    }

    return row;
  });
}

export async function updateProduct(
  shopId: string,
  productId: string,
  patch: Partial<{
    name: string;
    sku: string;
    barcode: string | null;
    categoryId: string | null;
    brandId: string | null;
    uomId: string | null;
    listPrice: string;
    unitCost: string;
    minStockLevel: number;
    active: boolean;
    isBundle: boolean;
    metadata: Record<string, unknown>;
    website: {
      visible?: boolean;
      slug?: string | null;
      shortDescription?: string | null;
      longDescription?: string | null;
    };
    inventoryTracked: boolean;
    batchTrackingEnabled: boolean;
    batchDatesRequired: boolean;
  }>,
) {
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!existing) throw AppError.notFound('Product not found');

  if (
    patch.batchTrackingEnabled !== undefined ||
    patch.batchDatesRequired !== undefined
  ) {
    if (existing.trackingMode !== 'QUANTITY') {
      throw AppError.badRequest('Batch tracking applies to QUANTITY products only');
    }
    const enabling = patch.batchTrackingEnabled === true;
    if (enabling && patch.batchDatesRequired === undefined) {
      patch.batchDatesRequired = true;
    }
    if (patch.batchTrackingEnabled === false) {
      patch.batchDatesRequired = false;
    }
  }

  const nextPatch: typeof patch = { ...patch };

  if (patch.website !== undefined) {
    const currentMeta =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};
    const currentWebsite =
      currentMeta.website && typeof currentMeta.website === 'object' && !Array.isArray(currentMeta.website)
        ? { ...(currentMeta.website as Record<string, unknown>) }
        : {};

    if (patch.website.visible !== undefined) currentWebsite.visible = patch.website.visible;
    if (patch.website.slug !== undefined) currentWebsite.slug = patch.website.slug;
    if (patch.website.shortDescription !== undefined)
      currentWebsite.shortDescription = patch.website.shortDescription;
    if (patch.website.longDescription !== undefined)
      currentWebsite.longDescription = patch.website.longDescription;

    currentMeta.website = currentWebsite;
    nextPatch.metadata = currentMeta;
    delete (nextPatch as any).website;

    await db
      .insert(productWebsiteProfiles)
      .values({
        shopId,
        productId,
        visible: patch.website.visible ?? false,
        seoSlug: patch.website.slug || null,
        shortDescription: patch.website.shortDescription || null,
        longDescription: patch.website.longDescription || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [productWebsiteProfiles.shopId, productWebsiteProfiles.productId],
        set: {
          ...(patch.website.visible !== undefined ? { visible: patch.website.visible } : {}),
          ...(patch.website.slug !== undefined ? { seoSlug: patch.website.slug || null } : {}),
          ...(patch.website.shortDescription !== undefined ? { shortDescription: patch.website.shortDescription || null } : {}),
          ...(patch.website.longDescription !== undefined ? { longDescription: patch.website.longDescription || null } : {}),
          updatedAt: new Date(),
        },
      });
  }

  const setValues: any = { ...nextPatch };
  if (patch.minStockLevel !== undefined) {
    setValues.minStockLevel = String(patch.minStockLevel);
  }

  const [row] = await db
    .update(products)
    .set({
      ...setValues,
      updatedAt: new Date(),
    })
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .returning();

  return row!;
}

export async function getProductById(shopId: string, productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  return row ?? null;
}

export async function getProductByBarcode(shopId: string, barcode: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.shopId, shopId),
        eq(products.barcode, barcode.trim()),
        eq(products.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function setBundleItems(
  shopId: string,
  bundleProductId: string,
  items: { componentProductId: string; quantity: string }[],
) {
  const bundle = await getProductById(shopId, bundleProductId);
  if (!bundle) throw AppError.notFound('Bundle product not found');
  if (!bundle.isBundle) {
    throw AppError.badRequest('Product is not marked as bundle (is_bundle)');
  }

  await db.transaction(async (tx) => {
    await tx.delete(bundleItems).where(eq(bundleItems.bundleProductId, bundleProductId));
    if (items.length === 0) return;
    await tx.insert(bundleItems).values(
      items.map((i) => ({
        bundleProductId,
        componentProductId: i.componentProductId,
        quantity: i.quantity,
      })),
    );
  });
}

export async function getBundleItems(bundleProductId: string) {
  return db
    .select()
    .from(bundleItems)
    .where(eq(bundleItems.bundleProductId, bundleProductId));
}
