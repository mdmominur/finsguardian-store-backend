import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  customerAddresses,
  customers,
  deliveryLocations,
  deviceUnits,
  inventoryBalances,
  productWebsiteImages,
  productWebsiteProfiles,
  products,
  sales,
  shops,
  shopUsers,
  storefrontFulfillmentOrderLines,
  storefrontFulfillmentOrders,
  users,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { addMoney, mulMoney } from '../lib/money.js';
import * as shopWebsiteService from './shop-website.service.js';
import { createHold } from './pos.service.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';
import { isMailConfigured, sendOrderConfirmationEmail } from './mail.service.js';

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
  shippingAddressId?: string | null;
  deliveryLocationId?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  shippingAddressText?: string | null;
  customerNote?: string | null;
  lines: { productId: string; qty: number }[];
  idempotencyKey?: string | null;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const shipId = input.shippingAddressId?.trim() || null;
  const deliveryLocId = input.deliveryLocationId?.trim() || null;

  const [custRow] = await db
    .select({
      id: customers.id,
      email: customers.email,
      name: customers.name,
      phone: customers.phone,
      address: customers.address,
    })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.shopId, shop.id)))
    .limit(1);
  if (!custRow) throw AppError.badRequest('Customer not found');

  let resolvedShippingAddressId: string | null = null;
  let resolvedShippingAddressString: string | null = input.shippingAddressText?.trim() || null;
  let resolvedDeliveryLocationId: string | null = null;
  let resolvedDeliveryCharge = '0';

  if (shipId) {
    const [addr] = await db
      .select({
        id: customerAddresses.id,
        line1: customerAddresses.line1,
        line2: customerAddresses.line2,
        city: customerAddresses.city,
        postalCode: customerAddresses.postalCode,
        recipientName: customerAddresses.recipientName,
        phone: customerAddresses.phone,
      })
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
    if (!resolvedShippingAddressString) {
      resolvedShippingAddressString = [addr.line1, addr.line2, addr.city, addr.postalCode]
        .filter(Boolean)
        .join(', ');
    }
  }

  if (!resolvedShippingAddressString && custRow.address) {
    resolvedShippingAddressString = custRow.address;
  }

  const resolvedRecipientName = input.recipientName?.trim() || custRow.name || null;
  const resolvedRecipientPhone = input.recipientPhone?.trim() || custRow.phone || null;
  const resolvedCustomerNote = input.customerNote?.trim() || null;

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
    const q = Number(raw.qty);
    if (!Number.isFinite(q) || q <= 0) {
      throw AppError.badRequest('Each line needs a positive quantity');
    }
    mergedQty.set(raw.productId, (mergedQty.get(raw.productId) ?? 0) + q);
  }

  const resolvedLines: { productId: string; name: string; qty: string; unitPrice: string }[] = [];

  for (const [productId, q] of mergedQty) {
    const [row] = await db
      .select({
        id: products.id,
        name: products.name,
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
    resolvedLines.push({
      productId: row.id,
      name: row.name,
      qty: String(q),
      unitPrice: row.listPrice,
    });
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
        recipientName: resolvedRecipientName,
        recipientPhone: resolvedRecipientPhone,
        shippingAddressText: resolvedShippingAddressString,
        customerNote: resolvedCustomerNote,
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

  const website = shopWebsiteService.readWebsiteSettings(shop.settings);

  if (isMailConfigured(shop.settings)) {
    const emailItems = resolvedLines.map((rl) => ({
      name: rl.name || 'Product',
      qty: Number(rl.qty),
      total: mulMoney(rl.qty, rl.unitPrice),
    }));

    let subtotal = '0';
    for (const it of emailItems) subtotal = addMoney(subtotal, it.total);
    const grandTotal = addMoney(subtotal, resolvedDeliveryCharge);

    const emailOpts = {
      shopName: shop.name,
      shopLogo: website.logoUrl,
      shopContact: {
        email: website.contact.supportEmail,
        phone: website.contact.supportPhone,
        address: website.footer.address,
      },
      orderRef: orderRow.publicRef,
      subtotal,
      deliveryCharge: resolvedDeliveryCharge,
      total: grandTotal,
      items: emailItems,
      customer: {
        name: resolvedRecipientName || custRow.name,
        email: custRow.email,
        phone: resolvedRecipientPhone || custRow.phone,
        address: resolvedShippingAddressString || custRow.address,
      },
      shopSettings: shop.settings,
    };

    if (custRow.email) {
      sendOrderConfirmationEmail({ ...emailOpts, to: custRow.email }).catch((err) =>
        console.error('[storefront-fulfillment] Failed to send customer order email:', err),
      );
    }

    db.select({ email: users.email })
      .from(shopUsers)
      .innerJoin(users, eq(users.id, shopUsers.userId))
      .where(and(eq(shopUsers.shopId, shop.id), eq(shopUsers.role, 'owner')))
      .limit(1)
      .then(([owner]) => {
        if (owner?.email) {
          sendOrderConfirmationEmail({ ...emailOpts, to: owner.email }).catch((err) =>
            console.error('[storefront-fulfillment] Failed to send owner order email:', err),
          );
        }
      });
  }

  return { duplicate: false as const, order: orderRow };
}

export async function attachSaleToFulfillmentOrder(input: {
  shopId: string;
  fulfillmentOrderId: string;
  saleId: string;
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

/** Cancel a PROCESSING website order before POS fulfillment. */
export async function cancelStorefrontFulfillmentOrder(input: {
  shopId: string;
  orderId: string;
  reason?: string | null;
}) {
  const [fo] = await db
    .select()
    .from(storefrontFulfillmentOrders)
    .where(
      and(eq(storefrontFulfillmentOrders.id, input.orderId), eq(storefrontFulfillmentOrders.shopId, input.shopId)),
    )
    .limit(1);
  if (!fo) throw AppError.notFound('Order not found');
  if (fo.status !== 'PROCESSING') {
    throw AppError.conflict('Only processing orders can be cancelled directly before POS checkout');
  }

  await db
    .update(storefrontFulfillmentOrders)
    .set({
      status: 'CANCELLED',
      cancelledReason: input.reason?.trim() || 'Cancelled by staff before checkout',
      cancelledAt: new Date(),
    })
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
      deliveryLocationName: deliveryLocations.name,
      deliveryCharge: storefrontFulfillmentOrders.deliveryCharge,
      recipientName: storefrontFulfillmentOrders.recipientName,
      recipientPhone: storefrontFulfillmentOrders.recipientPhone,
      shippingAddressText: storefrontFulfillmentOrders.shippingAddressText,
      customerNote: storefrontFulfillmentOrders.customerNote,
      cancelledReason: storefrontFulfillmentOrders.cancelledReason,
      cancelledAt: storefrontFulfillmentOrders.cancelledAt,
      saleId: storefrontFulfillmentOrders.saleId,
      saleInvoiceNo: sales.invoiceNo,
    })
    .from(storefrontFulfillmentOrders)
    .leftJoin(sales, eq(sales.id, storefrontFulfillmentOrders.saleId))
    .leftJoin(deliveryLocations, eq(deliveryLocations.id, storefrontFulfillmentOrders.deliveryLocationId))
    .where(and(eq(storefrontFulfillmentOrders.shopId, input.shopId), eq(storefrontFulfillmentOrders.status, st)))
    .orderBy(desc(storefrontFulfillmentOrders.createdAt))
    .limit(100);

  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const custRows =
    customerIds.length > 0
      ? await db
          .select({
            id: customers.id,
            name: customers.name,
            phone: customers.phone,
            email: customers.email,
            address: customers.address,
          })
          .from(customers)
          .where(and(eq(customers.shopId, input.shopId), inArray(customers.id, customerIds)))
      : [];

  const custMap = new Map(custRows.map((c) => [c.id, c]));

  const orderIds = rows.map((r) => r.id);
  const allLines =
    orderIds.length > 0
      ? await db
          .select({
            id: storefrontFulfillmentOrderLines.id,
            orderId: storefrontFulfillmentOrderLines.orderId,
            productId: storefrontFulfillmentOrderLines.productId,
            productName: products.name,
            sku: products.sku,
            qty: storefrontFulfillmentOrderLines.qty,
            unitPrice: storefrontFulfillmentOrderLines.unitPrice,
            coverImageUrl: sql<string | null>`(select url from ${productWebsiteImages} i where i.shop_id = ${products.shopId} and i.product_id = ${products.id} and i.kind = 'COVER' and i.is_active = true order by i.sort_order asc, i.created_at desc limit 1)`,
          })
          .from(storefrontFulfillmentOrderLines)
          .innerJoin(products, eq(products.id, storefrontFulfillmentOrderLines.productId))
          .where(inArray(storefrontFulfillmentOrderLines.orderId, orderIds))
      : [];

  const linesByOrder = new Map<string, typeof allLines>();
  for (const ln of allLines) {
    const arr = linesByOrder.get(ln.orderId) ?? [];
    arr.push(ln);
    linesByOrder.set(ln.orderId, arr);
  }

  const out = [];
  for (const r of rows) {
    const lineRows = linesByOrder.get(r.id) ?? [];

    let subtotal = '0';
    const lines = lineRows.map((ln) => {
      const lineTotal = mulMoney(ln.qty, ln.unitPrice);
      subtotal = addMoney(subtotal, lineTotal);
      return {
        id: ln.id,
        productId: ln.productId,
        productName: ln.productName,
        sku: ln.sku,
        qty: ln.qty,
        unitPrice: ln.unitPrice,
        lineTotal,
        coverImageUrl: ln.coverImageUrl,
      };
    });

    const c = custMap.get(r.customerId);
    out.push({
      ...r,
      customerName: r.recipientName || c?.name || null,
      customerPhone: r.recipientPhone || c?.phone || null,
      customerEmail: c?.email ?? null,
      shippingAddress: r.shippingAddressText || c?.address || null,
      lineCount: lineRows.length,
      lines,
      subtotal,
      total: addMoney(subtotal, r.deliveryCharge ?? '0'),
    });
  }

  return { items: out };
}

/** Complete Order & Customer 360 Inspector before going to POS checkout. */
export async function getStaffFulfillmentOrderDetail(input: { shopId: string; orderId: string }) {
  const [fo] = await db
    .select({
      id: storefrontFulfillmentOrders.id,
      publicRef: storefrontFulfillmentOrders.publicRef,
      status: storefrontFulfillmentOrders.status,
      createdAt: storefrontFulfillmentOrders.createdAt,
      customerId: storefrontFulfillmentOrders.customerId,
      shippingAddressId: storefrontFulfillmentOrders.shippingAddressId,
      deliveryLocationId: storefrontFulfillmentOrders.deliveryLocationId,
      deliveryLocationName: deliveryLocations.name,
      deliveryCharge: storefrontFulfillmentOrders.deliveryCharge,
      recipientName: storefrontFulfillmentOrders.recipientName,
      recipientPhone: storefrontFulfillmentOrders.recipientPhone,
      shippingAddressText: storefrontFulfillmentOrders.shippingAddressText,
      customerNote: storefrontFulfillmentOrders.customerNote,
      cancelledReason: storefrontFulfillmentOrders.cancelledReason,
      cancelledAt: storefrontFulfillmentOrders.cancelledAt,
      saleId: storefrontFulfillmentOrders.saleId,
      saleInvoiceNo: sales.invoiceNo,
    })
    .from(storefrontFulfillmentOrders)
    .leftJoin(sales, eq(sales.id, storefrontFulfillmentOrders.saleId))
    .leftJoin(deliveryLocations, eq(deliveryLocations.id, storefrontFulfillmentOrders.deliveryLocationId))
    .where(
      and(eq(storefrontFulfillmentOrders.id, input.orderId), eq(storefrontFulfillmentOrders.shopId, input.shopId)),
    )
    .limit(1);

  if (!fo) throw AppError.notFound('Fulfillment order not found');

  const [cust] = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
      address: customers.address,
      notes: customers.notes,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(and(eq(customers.id, fo.customerId), eq(customers.shopId, input.shopId)))
    .limit(1);

  const savedAddresses = await db
    .select()
    .from(customerAddresses)
    .where(and(eq(customerAddresses.shopId, input.shopId), eq(customerAddresses.customerId, fo.customerId)));

  // Past order statistics for this customer
  const [orderStats] = await db
    .select({
      totalWebOrders: sql<number>`count(*)::int`,
      shippedOrders: sql<number>`count(*) filter (where ${storefrontFulfillmentOrders.status} = 'SHIPPED')::int`,
      cancelledOrders: sql<number>`count(*) filter (where ${storefrontFulfillmentOrders.status} = 'CANCELLED')::int`,
    })
    .from(storefrontFulfillmentOrders)
    .where(
      and(
        eq(storefrontFulfillmentOrders.shopId, input.shopId),
        eq(storefrontFulfillmentOrders.customerId, fo.customerId),
      ),
    );

  const [spendStats] = await db
    .select({
      totalSpent: sql<string>`coalesce(sum(${sales.total}), 0)::text`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.shopId, input.shopId),
        eq(sales.customerId, fo.customerId),
        eq(sales.status, 'COMPLETED'),
      ),
    );

  const lineRows = await db
    .select({
      id: storefrontFulfillmentOrderLines.id,
      productId: storefrontFulfillmentOrderLines.productId,
      qty: storefrontFulfillmentOrderLines.qty,
      unitPrice: storefrontFulfillmentOrderLines.unitPrice,
      productName: products.name,
      sku: products.sku,
      trackingMode: products.trackingMode,
      inventoryTracked: products.inventoryTracked,
      coverImageUrl: sql<string | null>`(select url from ${productWebsiteImages} i where i.shop_id = ${products.shopId} and i.product_id = ${products.id} and i.kind = 'COVER' and i.is_active = true order by i.sort_order asc, i.created_at desc limit 1)`,
      bulkStockQty: sql<string>`coalesce((select sum(b.quantity) from ${inventoryBalances} b where b.shop_id = ${products.shopId} and b.product_id = ${products.id}), 0)::text`,
      serialStockQty: sql<string>`coalesce((select count(*) from ${deviceUnits} d where d.shop_id = ${products.shopId} and d.product_id = ${products.id} and d.status = 'IN_STOCK' and not d.blocklisted), 0)::text`,
    })
    .from(storefrontFulfillmentOrderLines)
    .innerJoin(products, eq(products.id, storefrontFulfillmentOrderLines.productId))
    .where(eq(storefrontFulfillmentOrderLines.orderId, fo.id));

  let subtotal = '0';
  const lines = lineRows.map((ln) => {
    const lineTotal = mulMoney(ln.qty, ln.unitPrice);
    subtotal = addMoney(subtotal, lineTotal);
    const currentStockQty =
      ln.trackingMode === 'SERIALIZED' ? Number(ln.serialStockQty) : Number(ln.bulkStockQty);
    return {
      id: ln.id,
      productId: ln.productId,
      productName: ln.productName,
      sku: ln.sku,
      trackingMode: ln.trackingMode,
      inventoryTracked: ln.inventoryTracked !== false,
      currentStockQty,
      qty: ln.qty,
      unitPrice: ln.unitPrice,
      lineTotal,
      coverImageUrl: ln.coverImageUrl,
    };
  });

  const total = addMoney(subtotal, fo.deliveryCharge ?? '0');

  return {
    order: {
      ...fo,
      subtotal,
      total,
      shippingAddress: fo.shippingAddressText || cust?.address || null,
      recipientName: fo.recipientName || cust?.name || null,
      recipientPhone: fo.recipientPhone || cust?.phone || null,
    },
    customer: cust
      ? {
          ...cust,
          savedAddresses,
          stats: {
            totalWebOrders: orderStats?.totalWebOrders ?? 1,
            shippedOrders: orderStats?.shippedOrders ?? 0,
            cancelledOrders: orderStats?.cancelledOrders ?? 0,
            totalSpent: spendStats?.totalSpent ?? '0',
          },
        }
      : null,
    lines,
  };
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
    if (!Number.isFinite(unitPrice) || !Number.isFinite(qtyN) || qtyN <= 0) continue;

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
        qty: qtyN,
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
