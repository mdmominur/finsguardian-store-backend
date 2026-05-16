import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  products,
  saleLines,
  sales,
  shops,
  storefrontFulfillmentOrderLines,
  storefrontFulfillmentOrders,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { addMoney, mulMoney } from '../lib/money.js';
import * as shopWebsiteService from './shop-website.service.js';

async function shopBySlugOrThrow(shopSlug: string) {
  const slug = shopSlug.trim();
  const [row] = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
  if (!row) throw AppError.notFound('Shop not found');
  const w = shopWebsiteService.readWebsiteSettings(row.settings);
  if (!w.enabled) throw AppError.notFound('Not published');
  return row;
}

type ListRow = {
  id: string;
  invoiceNo: string;
  soldAt: Date;
  status: string;
  channel: string;
  total: string;
  paidTotal: string;
  dueAmount: string;
};

/** Labels for storefront account (avoid raw sale status e.g. COMPLETED on web checkouts). */
function mapCustomerOrderStatus(channel: string, dbStatus: string): string {
  if (channel === 'WEB') {
    if (dbStatus === 'COMPLETED') return 'Shipped';
    if (dbStatus === 'VOID') return 'Cancelled';
    if (dbStatus === 'REFUNDED') return 'Refunded';
    if (dbStatus === 'PARTIALLY_REFUNDED') return 'Partially refunded';
  }
  return dbStatus;
}

function fulfillmentOpenLabel(status: string): string {
  if (status === 'PROCESSING') return 'Processing';
  if (status === 'OUT_FOR_DELIVERY') return 'Out for delivery';
  return status;
}

export async function listMyOrders(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  limit: number;
  offset: number;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const openFulfillment = await db
    .select({
      id: storefrontFulfillmentOrders.id,
      publicRef: storefrontFulfillmentOrders.publicRef,
      createdAt: storefrontFulfillmentOrders.createdAt,
      status: storefrontFulfillmentOrders.status,
      saleId: storefrontFulfillmentOrders.saleId,
      deliveryCharge: storefrontFulfillmentOrders.deliveryCharge,
    })
    .from(storefrontFulfillmentOrders)
    .where(
      and(
        eq(storefrontFulfillmentOrders.shopId, shop.id),
        eq(storefrontFulfillmentOrders.customerId, input.customerId),
        inArray(storefrontFulfillmentOrders.status, ['PROCESSING', 'OUT_FOR_DELIVERY']),
      ),
    )
    .orderBy(desc(storefrontFulfillmentOrders.createdAt))
    .limit(80);

  const openFoIds = openFulfillment.map((p) => p.id);
  const totals = new Map<string, string>();
  if (openFoIds.length > 0) {
    const lnRows = await db
      .select({
        orderId: storefrontFulfillmentOrderLines.orderId,
        qty: storefrontFulfillmentOrderLines.qty,
        unitPrice: storefrontFulfillmentOrderLines.unitPrice,
      })
      .from(storefrontFulfillmentOrderLines)
      .where(inArray(storefrontFulfillmentOrderLines.orderId, openFoIds));
    for (const ln of lnRows) {
      totals.set(ln.orderId, addMoney(totals.get(ln.orderId) ?? '0', mulMoney(ln.qty, ln.unitPrice)));
    }
  }

  const pendingItems: ListRow[] = openFulfillment.map((p) => {
    const subtotal = totals.get(p.id) ?? '0';
    const total = addMoney(subtotal, p.deliveryCharge ?? '0');
    return {
      id: p.id,
      invoiceNo: p.publicRef,
      soldAt: p.createdAt,
      status: fulfillmentOpenLabel(p.status),
      channel: 'WEB',
      total,
      paidTotal: '0',
      dueAmount: total,
    };
  });

  const linkedSaleIds = openFulfillment.map((p) => p.saleId).filter((id): id is string => Boolean(id));

  const saleWhere = [
    eq(sales.shopId, shop.id),
    eq(sales.customerId, input.customerId),
    ...(linkedSaleIds.length > 0 ? [notInArray(sales.id, linkedSaleIds)] : []),
  ];

  const saleRows = await db
    .select({
      id: sales.id,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
      status: sales.status,
      channel: sales.channel,
      total: sales.total,
      paidTotal: sales.paidTotal,
      dueAmount: sales.dueAmount,
    })
    .from(sales)
    .where(and(...saleWhere))
    .orderBy(desc(sales.soldAt))
    .limit(200);

  const saleRowsMapped: ListRow[] = saleRows.map((r) => ({
    ...r,
    status: mapCustomerOrderStatus(r.channel, r.status),
  }));

  const merged: ListRow[] = [...pendingItems, ...saleRowsMapped].sort(
    (a, b) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime(),
  );

  const slice = merged.slice(input.offset, input.offset + input.limit);
  return { items: slice };
}

export async function getMyOrderDetail(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  saleId: string;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const [fo] = await db
    .select()
    .from(storefrontFulfillmentOrders)
    .where(
      and(
        eq(storefrontFulfillmentOrders.id, input.saleId),
        eq(storefrontFulfillmentOrders.shopId, shop.id),
        eq(storefrontFulfillmentOrders.customerId, input.customerId),
      ),
    )
    .limit(1);

  if (fo && fo.status === 'PROCESSING') {
    const lines = await db
      .select({
        id: storefrontFulfillmentOrderLines.id,
        productId: storefrontFulfillmentOrderLines.productId,
        qty: storefrontFulfillmentOrderLines.qty,
        unitPrice: storefrontFulfillmentOrderLines.unitPrice,
      })
      .from(storefrontFulfillmentOrderLines)
      .where(eq(storefrontFulfillmentOrderLines.orderId, fo.id));

    const pids = [...new Set(lines.map((l) => l.productId))];
    const prows =
      pids.length > 0
        ? await db
            .select({ id: products.id, name: products.name, sku: products.sku })
            .from(products)
            .where(and(eq(products.shopId, shop.id), inArray(products.id, pids)))
        : [];
    const pmap = new Map(prows.map((p) => [p.id, p]));

    let subtotal = '0';
    const outLines = lines.map((ln) => {
      const p = pmap.get(ln.productId);
      const desc = p ? [p.name, p.sku].filter(Boolean).join(' • ') : ln.productId;
      const lineTotal = mulMoney(ln.qty, ln.unitPrice);
      subtotal = addMoney(subtotal, lineTotal);
      return {
        id: ln.id,
        productId: ln.productId,
        description: desc,
        qty: ln.qty,
        unitPrice: ln.unitPrice,
        lineTotal,
      };
    });

    const deliveryCharge = fo.deliveryCharge ?? '0';
    const grandTotal = addMoney(subtotal, deliveryCharge);

    return {
      sale: {
        id: fo.id,
        invoiceNo: fo.publicRef,
        soldAt: fo.createdAt,
        status: 'Processing',
        total: grandTotal,
        subtotal,
        deliveryCharge,
        paidTotal: '0',
        dueAmount: grandTotal,
      },
      lines: outLines,
    };
  }

  const linkedSaleId =
    fo && fo.saleId && (fo.status === 'OUT_FOR_DELIVERY' || fo.status === 'SHIPPED')
      ? fo.saleId
      : null;
  const saleLookupId = linkedSaleId ?? input.saleId;

  const [sale] = await db
    .select({
      id: sales.id,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
      status: sales.status,
      channel: sales.channel,
      total: sales.total,
      paidTotal: sales.paidTotal,
      dueAmount: sales.dueAmount,
    })
    .from(sales)
    .where(
      and(
        eq(sales.id, saleLookupId),
        eq(sales.shopId, shop.id),
        eq(sales.customerId, input.customerId),
      ),
    )
    .limit(1);
  if (!sale) throw AppError.notFound('Order not found');

  const lines = await db
    .select({
      id: saleLines.id,
      productId: saleLines.productId,
      description: saleLines.description,
      qty: saleLines.qty,
      unitPrice: saleLines.unitPrice,
      lineTotal: saleLines.lineTotal,
    })
    .from(saleLines)
    .where(eq(saleLines.saleId, sale.id));

  // Calculate subtotal from lines for display
  let subtotalAmt = '0';
  for (const ln of lines) {
    subtotalAmt = addMoney(subtotalAmt, ln.lineTotal);
  }
  const deliveryCharge = addMoney(sale.total, '0') === subtotalAmt
    ? '0'
    : addMoney(sale.total, mulMoney('-1', subtotalAmt));

  const { channel, status: rawStatus, ...saleRest } = sale;
  return {
    sale: {
      ...saleRest,
      status: mapCustomerOrderStatus(channel, rawStatus),
      subtotal: subtotalAmt,
      deliveryCharge: fo?.deliveryCharge ?? deliveryCharge,
    },
    lines,
  };
}
