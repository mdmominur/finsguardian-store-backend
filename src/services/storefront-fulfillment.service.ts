import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  customerAddresses,
  customers,
  deliveryLocations,
  productWebsiteProfiles,
  products,
  sales,
  shops,
  storefrontFulfillmentOrderLines,
  storefrontFulfillmentOrders,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { addMoney, mulMoney } from '../lib/money.js';
import * as shopWebsiteService from './shop-website.service.js';
import { createHold } from './pos.service.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';

function newPublicRef(): string {
  return `WEB-${randomBytes(4).toString('hex').toUpperCase()}`;
}

async function shopBySlugOrThrow(shopSlug: string) {
  const slug = shopSlug.trim();
  const [row] = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
  if (!row || row.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');
  const w = shopWebsiteService.readWebsiteSettings(row.settings);
  if (!w.enabled) throw AppError.notFound('Not published');
  return row;
}

export async function placeStorefrontFulfillmentOrder(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  /** Optional: saved address book row. If omitted, customer profile `customers.address` must be set. */
  shippingAddressId?: string | null;
  /** Optional storefront-selected delivery location. */
  deliveryLocationId?: string | null;
  lines: { productId: string; qty: number }[];
  idempotencyKey?: string | null;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const shipId = input.shippingAddressId?.trim() || null;
  const deliveryLocId = input.deliveryLocationId?.trim() || null;

  const [custRow] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.shopId, shop.id)))
    .limit(1);
  if (!custRow) throw AppError.badRequest('Customer not found');

  let resolvedShippingAddressId: string | null = null;
  let resolvedDeliveryLocationId: string | null = null;
  let resolvedDeliveryCharge = '0';

  if (shipId) {
    const [addr] = await db
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(
        and(
          eq(customerAddresses.id, shipId),
          eq(customerAddresses.shopId, shop.id),
          eq(customerAddresses.customerId, input.customerId),
        ),
      )
      .limit(1);
    if (!addr) throw AppError.badRequest('Delivery address not found');
    resolvedShippingAddressId = addr.id;
  }
  // No saved address id: storefront does not collect address right now — optional `customers.address`
  // in DB remains for future use; fulfillment row ships with null shipping_address_id.
  if (deliveryLocId) {
    const [loc] = await db
      .select({ id: deliveryLocations.id, deliveryCharge: deliveryLocations.deliveryCharge })
      .from(deliveryLocations)
      .where(
        and(
          eq(deliveryLocations.id, deliveryLocId),
          eq(deliveryLocations.shopId, shop.id),
          eq(deliveryLocations.isActive, true),
        ),
      )
      .limit(1);
    if (!loc) throw AppError.badRequest('Delivery location not found');
    resolvedDeliveryLocationId = loc.id;
    resolvedDeliveryCharge = loc.deliveryCharge;
  }

  if (input.lines.length === 0) throw AppError.badRequest('Cart is empty');

  const idem = input.idempotencyKey?.trim() || null;
  if (idem) {
    const [existing] = await db
      .select()
      .from(storefrontFulfillmentOrders)
      .where(
        and(
          eq(storefrontFulfillmentOrders.shopId, shop.id),
          eq(storefrontFulfillmentOrders.idempotencyKey, idem),
        ),
      )
      .limit(1);
    if (existing) {
      return { duplicate: true as const, order: existing };
    }
  }

  const mergedQty = new Map<string, number>();
  for (const raw of input.lines) {
    const q = Math.floor(Number(raw.qty));
    if (!Number.isFinite(q) || q < 1) {
      throw AppError.badRequest('Each line needs a positive whole-number quantity');
    }
    mergedQty.set(raw.productId, (mergedQty.get(raw.productId) ?? 0) + q);
  }

  const resolvedLines: { productId: string; qty: string; unitPrice: string }[] = [];

  for (const [productId, q] of mergedQty) {
    const [row] = await db
      .select({
        id: products.id,
        listPrice: products.listPrice,
      })
      .from(products)
      .innerJoin(
        productWebsiteProfiles,
        and(
          eq(productWebsiteProfiles.shopId, products.shopId),
          eq(productWebsiteProfiles.productId, products.id),
          eq(productWebsiteProfiles.visible, true),
        ),
      )
      .where(and(eq(products.id, productId), eq(products.shopId, shop.id), eq(products.active, true)))
      .limit(1);

    if (!row) {
      throw AppError.badRequest('One or more products are not available on this shop’s website');
    }
    resolvedLines.push({ productId: row.id, qty: String(q), unitPrice: row.listPrice });
  }

  const orderRow = await db.transaction(async (tx) => {
    const publicRef = newPublicRef();
    const [order] = await tx
      .insert(storefrontFulfillmentOrders)
      .values({
        shopId: shop.id,
        customerId: input.customerId,
        shippingAddressId: resolvedShippingAddressId,
        deliveryLocationId: resolvedDeliveryLocationId,
        deliveryCharge: resolvedDeliveryCharge,
        status: 'PROCESSING',
        publicRef,
        idempotencyKey: idem,
      })
      .returning();

    if (!order) throw AppError.conflict('Order failed');

    for (const ln of resolvedLines) {
      await tx.insert(storefrontFulfillmentOrderLines).values({
        orderId: order.id,
        productId: ln.productId,
        qty: ln.qty,
        unitPrice: ln.unitPrice,
      });
    }

    return order;
  });

  return { duplicate: false as const, order: orderRow };
}

export async function attachSaleToFulfillmentOrder(input: {
  shopId: string;
  fulfillmentOrderId: string;
  saleId: string;
  /** Optional: ensure sale belongs to this customer when set */
  expectedCustomerId?: string | null;
}) {
  const [fo] = await db
    .select()
    .from(storefrontFulfillmentOrders)
    .where(
      and(
        eq(storefrontFulfillmentOrders.id, input.fulfillmentOrderId),
        eq(storefrontFulfillmentOrders.shopId, input.shopId),
      ),
    )
    .limit(1);
  if (!fo) throw AppError.notFound('Fulfillment order not found');
  if (fo.status !== 'PROCESSING') {
    throw AppError.conflict('This website order is not awaiting POS checkout');
  }

  const [sale] = await db
    .select({ id: sales.id, customerId: sales.customerId, channel: sales.channel })
    .from(sales)
    .where(and(eq(sales.id, input.saleId), eq(sales.shopId, input.shopId)))
    .limit(1);
  if (!sale) throw AppError.notFound('Sale not found');
  if (sale.channel !== 'WEB') {
    throw AppError.badRequest('Sale must be a web-channel checkout to attach to this order');
  }
  if (input.expectedCustomerId && sale.customerId !== input.expectedCustomerId) {
    throw AppError.badRequest('Sale customer does not match the website order');
  }
  if (fo.customerId !== sale.customerId) {
    throw AppError.badRequest('Sale customer does not match the website order');
  }

  await db
    .update(storefrontFulfillmentOrders)
    .set({ status: 'OUT_FOR_DELIVERY', saleId: sale.id })
    .where(eq(storefrontFulfillmentOrders.id, fo.id));

  return { ok: true as const };
}

/** After staff confirms the customer received the goods (POS sale already created). */
export async function markStorefrontFulfillmentShipped(input: { shopId: string; orderId: string }) {
  const [fo] = await db
    .select()
    .from(storefrontFulfillmentOrders)
    .where(
      and(eq(storefrontFulfillmentOrders.id, input.orderId), eq(storefrontFulfillmentOrders.shopId, input.shopId)),
    )
    .limit(1);
  if (!fo) throw AppError.notFound('Order not found');
  if (fo.status !== 'OUT_FOR_DELIVERY') {
    throw AppError.conflict('Only out-for-delivery orders can be marked shipped');
  }

  await db
    .update(storefrontFulfillmentOrders)
    .set({ status: 'SHIPPED' })
    .where(eq(storefrontFulfillmentOrders.id, fo.id));

  return { ok: true as const, publicRef: fo.publicRef };
}

export async function listStaffFulfillmentOrders(input: {
  shopId: string;
  status?: 'PROCESSING' | 'OUT_FOR_DELIVERY' | 'SHIPPED' | 'CANCELLED';
}) {
  const st = input.status ?? 'PROCESSING';
  const rows = await db
    .select({
      id: storefrontFulfillmentOrders.id,
      publicRef: storefrontFulfillmentOrders.publicRef,
      status: storefrontFulfillmentOrders.status,
      createdAt: storefrontFulfillmentOrders.createdAt,
      customerId: storefrontFulfillmentOrders.customerId,
        deliveryLocationId: storefrontFulfillmentOrders.deliveryLocationId,
        deliveryCharge: storefrontFulfillmentOrders.deliveryCharge,
      saleId: storefrontFulfillmentOrders.saleId,
      saleInvoiceNo: sales.invoiceNo,
    })
    .from(storefrontFulfillmentOrders)
    .leftJoin(sales, eq(sales.id, storefrontFulfillmentOrders.saleId))
    .where(and(eq(storefrontFulfillmentOrders.shopId, input.shopId), eq(storefrontFulfillmentOrders.status, st)))
    .orderBy(desc(storefrontFulfillmentOrders.createdAt))
    .limit(100);

  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const custRows =
    customerIds.length > 0
      ? await db
          .select({ id: customers.id, name: customers.name, phone: customers.phone })
          .from(customers)
          .where(and(eq(customers.shopId, input.shopId), inArray(customers.id, customerIds)))
      : [];

  const custMap = new Map(custRows.map((c) => [c.id, c]));

  const out = [];
  for (const r of rows) {
    const lineRows = await db
      .select({
        productId: storefrontFulfillmentOrderLines.productId,
        qty: storefrontFulfillmentOrderLines.qty,
        unitPrice: storefrontFulfillmentOrderLines.unitPrice,
      })
      .from(storefrontFulfillmentOrderLines)
      .where(eq(storefrontFulfillmentOrderLines.orderId, r.id));

    let subtotal = '0';
    for (const ln of lineRows) {
      subtotal = addMoney(subtotal, mulMoney(ln.qty, ln.unitPrice));
    }

    const c = custMap.get(r.customerId);
    out.push({
      ...r,
      customerName: c?.name ?? null,
      customerPhone: c?.phone ?? null,
      lineCount: lineRows.length,
      subtotal,
      total: addMoney(subtotal, r.deliveryCharge ?? '0'),
    });
  }

  return { items: out };
}

/** Build POS hold payload `{ cart, webFulfillmentOrderId, customerId }` and create hold. */
export async function createPosHoldFromFulfillmentOrder(input: {
  shopId: string;
  userId: string;
  orderId: string;
}) {
  const [fo] = await db
    .select()
    .from(storefrontFulfillmentOrders)
    .where(and(eq(storefrontFulfillmentOrders.id, input.orderId), eq(storefrontFulfillmentOrders.shopId, input.shopId)))
    .limit(1);
  if (!fo) throw AppError.notFound('Order not found');
  if (fo.status !== 'PROCESSING') throw AppError.conflict('Order is not awaiting POS fulfillment');

  const lineRows = await db
    .select({
      productId: storefrontFulfillmentOrderLines.productId,
      qty: storefrontFulfillmentOrderLines.qty,
      unitPrice: storefrontFulfillmentOrderLines.unitPrice,
    })
    .from(storefrontFulfillmentOrderLines)
    .where(eq(storefrontFulfillmentOrderLines.orderId, fo.id));

  const productIds = [...new Set(lineRows.map((l) => l.productId))];
  const prows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      trackingMode: products.trackingMode,
      listPrice: products.listPrice,
      inventoryTracked: products.inventoryTracked,
    })
    .from(products)
    .where(and(eq(products.shopId, input.shopId), inArray(products.id, productIds)));

  const pmap = new Map(prows.map((p) => [p.id, p]));
  const multiLoc = await isMultiStockLocationEnabled(input.shopId);
  const defaultLoc = await resolveLocationIdOrDefault(input.shopId, null, multiLoc);
  const stockLoc = defaultLoc ?? '';

  const cart: unknown[] = [];

  for (const ln of lineRows) {
    const p = pmap.get(ln.productId);
    if (!p) throw AppError.conflict('Product missing from catalog');
    const label = [p.name, p.sku].filter(Boolean).join(' • ') || p.name;
    const unitPrice = Number(ln.unitPrice);
    const qtyN = Number(ln.qty);
    if (!Number.isFinite(unitPrice) || !Number.isFinite(qtyN) || qtyN < 1) continue;

    if (p.trackingMode === 'SERIALIZED') {
      for (let i = 0; i < Math.floor(qtyN); i++) {
        cart.push({
          kind: 'serialized_pending',
          productId: p.id,
          productLabel: label,
          unitPrice,
        });
      }
    } else {
      cart.push({
        kind: 'bulk',
        productId: p.id,
        productLabel: label,
        qty: Math.floor(qtyN),
        unitPrice,
        discount: 0,
        uomId: null,
        stockLocationId: stockLoc,
        batchId: null,
        inventoryTracked: p.inventoryTracked !== false,
      });
    }
  }

  const hold = await createHold(input.shopId, input.userId, {
    name: `Web ${fo.publicRef}`,
    payload: {
      cart,
      total: 0,
      heldAt: new Date().toISOString(),
      webFulfillmentOrderId: fo.id,
      customerId: fo.customerId,
      deliveryLocationId: fo.deliveryLocationId,
      deliveryCharge: fo.deliveryCharge,
    },
    expiresAt: null,
  });

  return { holdId: hold.id, publicRef: fo.publicRef };
}
