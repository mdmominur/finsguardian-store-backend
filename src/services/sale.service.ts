import { and, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  batchInventoryBalances,
  batchInventoryMovements,
  customerLedgerEntries,
  customers,
  deviceUnits,
  inventoryBalances,
  inventoryMovements,
  products,
  refundLines,
  refunds,
  saleLineBatchAllocations,
  saleLines,
  salePayments,
  sales,
  shopPaymentMethods,
  storefrontFulfillmentOrders,
  shops,
  stockLocations,
  uoms,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { normalizePromisePayDate } from '../lib/datetime.js';
import { getDefaultLocationId } from './stock-location.service.js';

function normalizeBdPhoneSearch(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `880${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('1')) return `880${digits}`;
  return digits;
}

function shopAddressFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const o = settings as Record<string, unknown>;
  const raw = o.invoiceAddress ?? o.shopAddress ?? o.address;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

async function quantityDeductedLocationNamesForSale(
  shopId: string,
  saleId: string,
): Promise<string[]> {
  const locRows = await db
    .select({ name: stockLocations.name })
    .from(inventoryMovements)
    .innerJoin(
      stockLocations,
      eq(stockLocations.id, inventoryMovements.locationId),
    )
    .where(
      and(
        eq(inventoryMovements.shopId, shopId),
        eq(inventoryMovements.refTable, 'sales'),
        eq(inventoryMovements.refId, saleId),
        eq(inventoryMovements.movementType, 'SALE'),
      ),
    )
    .groupBy(stockLocations.name);
  return locRows.map((r) => r.name);
}

export async function listSales(
  shopId: string,
  opts: {
    limit: number;
    offset: number;
    from?: Date;
    to?: Date;
    search?: string;
    status?: 'COMPLETED' | 'VOID' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
    channel?: 'POS' | 'WEB' | 'IMPORT';
  },
) {
  const conditions = [eq(sales.shopId, shopId)];
  if (opts.channel) {
    conditions.push(eq(sales.channel, opts.channel));
  }
  if (opts.from) {
    conditions.push(gte(sales.soldAt, opts.from));
  }
  if (opts.to) {
    conditions.push(lte(sales.soldAt, opts.to));
  }
  if (opts.status) {
    conditions.push(eq(sales.status, opts.status));
  }
  if (opts.search?.trim()) {
    const raw = opts.search.trim();
    const s = `%${raw}%`;
    const phoneNorm = normalizeBdPhoneSearch(raw);
    conditions.push(
      or(
        ilike(sales.invoiceNo, s),
        ilike(customers.name, s),
        ilike(customers.phone, s),
        eq(customers.phone, phoneNorm),
      )!,
    );
  }

  const whereClause = and(...conditions);

  const [countRow] = await db
    .select({ total: count() })
    .from(sales)
    .leftJoin(customers, eq(sales.customerId, customers.id))
    .where(whereClause);

  const rows = await db
    .select({
      id: sales.id,
      shopId: sales.shopId,
      invoiceNo: sales.invoiceNo,
      customerId: sales.customerId,
      soldAt: sales.soldAt,
      subtotal: sales.subtotal,
      discountTotal: sales.discountTotal,
      taxTotal: sales.taxTotal,
      total: sales.total,
      paidTotal: sales.paidTotal,
      dueAmount: sales.dueAmount,
      promisePayDate: sales.promisePayDate,
      status: sales.status,
      channel: sales.channel,
      cashierUserId: sales.cashierUserId,
      idempotencyKey: sales.idempotencyKey,
      createdAt: sales.createdAt,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(sales)
    .leftJoin(customers, eq(sales.customerId, customers.id))
    .where(whereClause)
    .orderBy(desc(sales.soldAt))
    .limit(opts.limit)
    .offset(opts.offset);

  return { items: rows, total: Number(countRow?.total ?? 0) };
}

export async function getSaleDetail(shopId: string, saleId: string) {
  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.shopId, shopId)))
    .limit(1);

  if (!sale) return null;

  const lines = await db
    .select({
      id: saleLines.id,
      saleId: saleLines.saleId,
      productId: saleLines.productId,
      description: saleLines.description,
      qty: saleLines.qty,
      unitPrice: saleLines.unitPrice,
      discount: saleLines.discount,
      lineTotal: saleLines.lineTotal,
      cogsUnitCost: saleLines.cogsUnitCost,
      deviceUnitId: saleLines.deviceUnitId,
      productName: products.name,
      productSku: products.sku,
      uomId: products.uomId,
      uomName: uoms.name,
      uomSymbol: uoms.symbol,
      uomIsActive: uoms.isActive,
    })
    .from(saleLines)
    .innerJoin(products, eq(products.id, saleLines.productId))
    .leftJoin(uoms, eq(uoms.id, products.uomId))
    .where(eq(saleLines.saleId, saleId));

  const refundedByLineRows = await db
    .select({
      saleLineId: refundLines.saleLineId,
      refundedQty: sql<string>`coalesce(sum(${refundLines.qty}::numeric), 0)::text`,
    })
    .from(refundLines)
    .innerJoin(refunds, eq(refunds.id, refundLines.refundId))
    .where(and(eq(refunds.shopId, shopId), eq(refunds.saleId, saleId)))
    .groupBy(refundLines.saleLineId);

  const refundedByLine = new Map<string, string>();
  for (const r of refundedByLineRows) refundedByLine.set(r.saleLineId, r.refundedQty);

  const linesWithRefunds = lines.map((l) => {
    const refundedQty = refundedByLine.get(l.id) ?? '0';
    const remainingQty = Math.max(0, Number(l.qty) - Number(refundedQty)).toFixed(2);
    return { ...l, refundedQty, remainingQty };
  });

  const payments = await db
    .select({
      id: salePayments.id,
      saleId: salePayments.saleId,
      paymentMethodId: salePayments.paymentMethodId,
      method: sql<string>`coalesce(${salePayments.methodLabelSnapshot}, ${shopPaymentMethods.name})`,
      amount: salePayments.amount,
      providerReference: salePayments.providerReference,
      createdAt: salePayments.createdAt,
    })
    .from(salePayments)
    .leftJoin(shopPaymentMethods, eq(shopPaymentMethods.id, salePayments.paymentMethodId))
    .where(eq(salePayments.saleId, saleId));

  let customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
  } | null = null;
  if (sale.customerId) {
    const [c] = await db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        address: customers.address,
      })
      .from(customers)
      .where(eq(customers.id, sale.customerId))
      .limit(1);
    customer = c ?? null;
  }

  const [shop] = await db
    .select({ name: shops.name, settings: shops.settings })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const quantityDeductedFromLocations = await quantityDeductedLocationNamesForSale(
    shopId,
    saleId,
  );

  return {
    sale,
    lines: linesWithRefunds,
    payments,
    customer,
    shopName: shop?.name ?? 'Store',
    shopAddress: shopAddressFromSettings(shop?.settings),
    quantityDeductedFromLocations,
  };
}

/** Public invoice by sale UUID — no shop filter; omit sensitive line fields. */
export async function getSaleDetailPublic(saleId: string) {
  const [sale] = await db.select().from(sales).where(eq(sales.id, saleId)).limit(1);
  if (!sale) return null;

  const shopId = sale.shopId;
  const lines = await db
    .select({
      id: saleLines.id,
      saleId: saleLines.saleId,
      productId: saleLines.productId,
      description: saleLines.description,
      qty: saleLines.qty,
      unitPrice: saleLines.unitPrice,
      discount: saleLines.discount,
      lineTotal: saleLines.lineTotal,
      deviceUnitId: saleLines.deviceUnitId,
      productName: products.name,
      productSku: products.sku,
      uomId: products.uomId,
      uomName: uoms.name,
      uomSymbol: uoms.symbol,
      uomIsActive: uoms.isActive,
    })
    .from(saleLines)
    .innerJoin(products, eq(products.id, saleLines.productId))
    .leftJoin(uoms, eq(uoms.id, products.uomId))
    .where(eq(saleLines.saleId, saleId));

  const payments = await db
    .select({
      id: salePayments.id,
      saleId: salePayments.saleId,
      paymentMethodId: salePayments.paymentMethodId,
      method: sql<string>`coalesce(${salePayments.methodLabelSnapshot}, ${shopPaymentMethods.name})`,
      amount: salePayments.amount,
      providerReference: salePayments.providerReference,
      createdAt: salePayments.createdAt,
    })
    .from(salePayments)
    .leftJoin(shopPaymentMethods, eq(shopPaymentMethods.id, salePayments.paymentMethodId))
    .where(eq(salePayments.saleId, saleId));

  let customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
  } | null = null;
  if (sale.customerId) {
    const [c] = await db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        address: customers.address,
      })
      .from(customers)
      .where(and(eq(customers.id, sale.customerId), eq(customers.shopId, shopId)))
      .limit(1);
    customer = c ?? null;
  }

  const [shop] = await db
    .select({ name: shops.name, settings: shops.settings })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const quantityDeductedFromLocations = await quantityDeductedLocationNamesForSale(
    shopId,
    saleId,
  );

  return {
    sale,
    lines,
    payments,
    customer,
    shopName: shop?.name ?? 'Store',
    shopAddress: shopAddressFromSettings(shop?.settings),
    quantityDeductedFromLocations,
  };
}

export async function createRefund(
  shopId: string,
  userId: string,
  saleId: string,
  input: {
    lines: { saleLineId: string; qty: string; amount: string; restock?: boolean }[];
    note?: string;
    paymentMethodId?: string | null;
  },
) {
  if (input.lines.length === 0) throw AppError.badRequest('Refund lines required');

  const locationId = await getDefaultLocationId(shopId);

  return db.transaction(async (tx) => {
    const [sale] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.shopId, shopId)))
      .limit(1);

    if (!sale) throw AppError.notFound('Sale not found');
    if (sale.status === 'VOID' || sale.status === 'REFUNDED') {
      throw AppError.conflict('Sale not refundable in current status');
    }

    let refundTotal = 0;

    for (const l of input.lines) {
      refundTotal += Number(l.amount);
    }

    let reverseDue = 0;
    if (sale.customerId && Number(sale.dueAmount) > 0) {
      reverseDue = Math.min(Number(sale.dueAmount), refundTotal);
    }
    const payoutAmount = Math.max(0, refundTotal - reverseDue);

    let paymentMethodId: string | null = null;
    if (payoutAmount > 0) {
      if (input.paymentMethodId) {
        const [methodRow] = await tx
          .select({ id: shopPaymentMethods.id })
          .from(shopPaymentMethods)
          .where(
            and(
              eq(shopPaymentMethods.id, input.paymentMethodId),
              eq(shopPaymentMethods.shopId, shopId),
              eq(shopPaymentMethods.isActive, true),
            ),
          )
          .limit(1);
        if (!methodRow) {
          throw AppError.badRequest('Invalid or inactive payment method selected for refund');
        }
        paymentMethodId = input.paymentMethodId;
      } else {
        const payments = await tx
          .select()
          .from(salePayments)
          .where(eq(salePayments.saleId, saleId));
        if (payments.length > 0 && payments[0]?.paymentMethodId) {
          paymentMethodId = payments[0].paymentMethodId;
        } else {
          const { getDefaultTenderPaymentMethodId } = await import('./shop-payment-method.service.js');
          paymentMethodId = await getDefaultTenderPaymentMethodId(shopId);
        }
      }
    }

    const [refund] = await tx
      .insert(refunds)
      .values({
        shopId,
        saleId,
        totalAmount: refundTotal.toFixed(2),
        note: input.note ?? null,
        createdBy: userId,
        paymentMethodId,
        payoutAmount: payoutAmount.toFixed(2),
      })
      .returning();

    if (!refund) throw AppError.conflict('Refund failed');

    for (const l of input.lines) {
      const [sl] = await tx
        .select()
        .from(saleLines)
        .where(
          and(eq(saleLines.id, l.saleLineId), eq(saleLines.saleId, saleId)),
        )
        .limit(1);

      if (!sl) throw AppError.notFound('Sale line not found');

      const maxQty = Number(sl.qty);
      const wantQty = Number(l.qty);
      if (!Number.isFinite(wantQty) || wantQty <= 0) {
        throw AppError.badRequest('Refund qty must be a positive number');
      }
      if (wantQty > maxQty + 1e-9) throw AppError.badRequest('Refund qty exceeds sold qty');

      const [already] = await tx
        .select({
          sumQty: sql<string>`coalesce(sum(${refundLines.qty}::numeric), 0)::text`,
        })
        .from(refundLines)
        .innerJoin(refunds, eq(refunds.id, refundLines.refundId))
        .where(
          and(
            eq(refunds.shopId, shopId),
            eq(refunds.saleId, saleId),
            eq(refundLines.saleLineId, sl.id),
          ),
        );
      const alreadyQty = Number(already?.sumQty ?? 0);
      const remaining = maxQty - alreadyQty;
      if (wantQty > remaining + 1e-9) {
        throw AppError.conflict('Refund qty exceeds remaining refundable qty', {
          soldQty: maxQty,
          alreadyRefundedQty: alreadyQty,
          remainingRefundableQty: Math.max(0, remaining),
          requestedQty: wantQty,
        });
      }

      await tx.insert(refundLines).values({
        refundId: refund.id,
        saleLineId: sl.id,
        qty: String(wantQty),
        amount: l.amount,
        restock: l.restock ?? true,
      });

      if (l.restock !== false) {
        if (sl.deviceUnitId) {
          await tx
            .update(deviceUnits)
            .set({
              status: 'IN_STOCK',
              soldSaleLineId: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(deviceUnits.id, sl.deviceUnitId),
                eq(deviceUnits.shopId, shopId),
              ),
            );
        } else {
          const [p] = await tx
            .select({
              id: products.id,
              trackingMode: products.trackingMode,
              batchTrackingEnabled: products.batchTrackingEnabled,
            })
            .from(products)
            .where(and(eq(products.id, sl.productId), eq(products.shopId, shopId)))
            .limit(1);

          const batchTracked = p?.trackingMode === 'QUANTITY' && p.batchTrackingEnabled === true;

          await tx
            .insert(inventoryBalances)
            .values({
              shopId,
              productId: sl.productId,
              locationId,
              quantity: String(wantQty),
            })
            .onConflictDoUpdate({
              target: [
                inventoryBalances.shopId,
                inventoryBalances.productId,
                inventoryBalances.locationId,
              ],
              set: {
                quantity: sql`${inventoryBalances.quantity}::numeric + ${String(wantQty)}::numeric`,
                updatedAt: new Date(),
              },
            });

          await tx.insert(inventoryMovements).values({
            shopId,
            productId: sl.productId,
            locationId,
            quantityDelta: String(wantQty),
            movementType: 'RMA_RETURN',
            refTable: 'refunds',
            refId: refund.id,
            createdBy: userId,
          });

          if (batchTracked) {
            // Restock back into the same batches used during the sale, using recorded allocations.
            // If allocations are missing (older sale), we keep aggregate-only restock.
            const allocRows = await tx
              .select({
                batchId: saleLineBatchAllocations.batchId,
                qty: saleLineBatchAllocations.qty,
              })
              .from(saleLineBatchAllocations)
              .where(eq(saleLineBatchAllocations.saleLineId, sl.id));

            let remainingToRestock = wantQty;
            for (const a of allocRows) {
              if (remainingToRestock <= 0) break;
              const take = Math.min(remainingToRestock, Number(a.qty));
              if (take <= 0) continue;
              const takeStr = take.toFixed(3);

              await tx
                .insert(batchInventoryBalances)
                .values({ shopId, batchId: a.batchId, locationId, quantity: takeStr })
                .onConflictDoUpdate({
                  target: [
                    batchInventoryBalances.shopId,
                    batchInventoryBalances.batchId,
                    batchInventoryBalances.locationId,
                  ],
                  set: {
                    quantity: sql`${batchInventoryBalances.quantity}::numeric + ${takeStr}::numeric`,
                    updatedAt: new Date(),
                  },
                });

              await tx.insert(batchInventoryMovements).values({
                shopId,
                batchId: a.batchId,
                productId: sl.productId,
                locationId,
                quantityDelta: takeStr,
                movementType: 'RMA_RETURN',
                refTable: 'refunds',
                refId: refund.id,
                createdBy: userId,
              });

              remainingToRestock -= take;
            }
          }
        }
      }
    }

    const [totalRefunded] = await tx
      .select({
        sumAmount: sql<string>`coalesce(sum(${refunds.totalAmount}::numeric), 0)::text`,
      })
      .from(refunds)
      .where(and(eq(refunds.shopId, shopId), eq(refunds.saleId, saleId)));

    const totalRefundedAmount = Number(totalRefunded?.sumAmount ?? 0);
    const newStatus =
      totalRefundedAmount >= Number(sale.total) - 1e-6 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    await tx
      .update(sales)
      .set({ status: newStatus })
      .where(eq(sales.id, saleId));

    if (newStatus === 'REFUNDED') {
      await tx
        .update(storefrontFulfillmentOrders)
        .set({ status: 'CANCELLED' })
        .where(
          and(
            eq(storefrontFulfillmentOrders.shopId, shopId),
            eq(storefrontFulfillmentOrders.saleId, saleId),
          ),
        );
    }

    if (reverseDue > 0 && sale.customerId) {
      await tx.insert(customerLedgerEntries).values({
        customerId: sale.customerId,
        entryType: 'ADJUSTMENT',
        amount: (-reverseDue).toFixed(2),
        refTable: 'refunds',
        refId: refund.id,
        note: 'Refund reduces customer due',
      });
    }

    return refund;
  });
}

/** Update promised payment date on an invoice that still has balance due. */
export async function updateSalePromisePayDate(
  shopId: string,
  saleId: string,
  promisePayDate: string,
) {
  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.shopId, shopId)))
    .limit(1);

  if (!sale) throw AppError.notFound('Sale not found');
  if (sale.status !== 'COMPLETED') {
    throw AppError.badRequest('Promise date can only be updated on completed sales');
  }
  if (Number(sale.dueAmount) <= 0) {
    throw AppError.badRequest('This sale has no balance due; a promised payment date does not apply');
  }

  let normalized: string;
  try {
    normalized = normalizePromisePayDate(promisePayDate);
  } catch (e) {
    throw AppError.badRequest(e instanceof Error ? e.message : 'Invalid promised payment date');
  }

  await db
    .update(sales)
    .set({ promisePayDate: normalized })
    .where(and(eq(sales.id, saleId), eq(sales.shopId, shopId)));

  return getSaleDetail(shopId, saleId);
}
