import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  purchaseOrders,
  shopPaymentMethods,
  supplierLedgerEntries,
  supplierPaymentPoAllocations,
  supplierPayments,
  suppliers,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import {
  listSupplierPurchaseLines,
  listUnpaidPurchaseOrdersForSupplier,
  money2,
  settlementByPoIdsTx,
} from './supplier-po-settlement.service.js';

async function supplierBalanceFromTx(tx: typeof db, supplierId: string): Promise<string> {
  const [s] = await tx
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!s) return '0';

  const [agg] = await tx
    .select({
      sum: sql<string>`coalesce(sum(${supplierLedgerEntries.amount}), 0)::text`,
    })
    .from(supplierLedgerEntries)
    .where(eq(supplierLedgerEntries.supplierId, supplierId));

  const opening = Number(s.openingBalance);
  const led = Number(agg?.sum ?? 0);
  return (opening + led).toFixed(2);
}

export async function supplierBalanceAmount(supplierId: string): Promise<string> {
  return supplierBalanceFromTx(db, supplierId);
}

export async function listSuppliers(shopId: string, includeBalance: boolean) {
  const rows = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.shopId, shopId))
    .orderBy(desc(suppliers.createdAt));

  if (!includeBalance) return rows;

  const out = [];
  for (const r of rows) {
    const balance = await supplierBalanceAmount(r.id);
    out.push({ ...r, balance });
  }
  return out;
}

export async function createSupplier(
  shopId: string,
  input: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
    openingBalance?: string;
  },
) {
  const opening = input.openingBalance ?? '0';

  const [row] = await db
    .insert(suppliers)
    .values({
      shopId,
      name: input.name.trim(),
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      openingBalance: opening,
    })
    .returning();

  if (!row) throw AppError.conflict('Could not create supplier');

  if (Number(opening) !== 0) {
    await db.insert(supplierLedgerEntries).values({
      supplierId: row.id,
      entryType: 'OPENING',
      amount: opening,
      note: 'Opening balance',
    });
  }

  return row;
}

export async function recordSupplierPayment(
  shopId: string,
  supplierId: string,
  userId: string | null,
  input: {
    amount: string;
    paymentMethodId: string;
    note?: string;
    allocations?: { poId: string; amount: string }[];
  },
) {
  const [s] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.shopId, shopId)))
    .limit(1);

  if (!s) throw AppError.notFound('Supplier not found');

  const amt = Number(input.amount);
  if (!amt || !Number.isFinite(amt) || amt <= 0) {
    throw AppError.badRequest('Payment amount must be positive');
  }

  const balanceNow = Number(await supplierBalanceAmount(supplierId));
  if (amt > balanceNow + 0.009) {
    throw AppError.badRequest(
      `Payment cannot exceed amount owed to this supplier (৳${money2(balanceNow)} outstanding)`,
    );
  }

  const allocations = input.allocations ?? [];

  if (allocations.length > 0) {
    let allocSum = 0;
    for (const a of allocations) {
      const x = Number(a.amount);
      if (!Number.isFinite(x) || x <= 0) {
        throw AppError.badRequest('Each allocation amount must be positive');
      }
      allocSum += x;
    }
    if (Math.abs(allocSum - amt) > 0.009) {
      throw AppError.badRequest('Allocations must sum exactly to the payment amount');
    }
  }

  const poIds = [...new Set(allocations.map((a) => a.poId))];

  return db.transaction(async (tx) => {
    const [pm] = await tx
      .select()
      .from(shopPaymentMethods)
      .where(and(eq(shopPaymentMethods.id, input.paymentMethodId), eq(shopPaymentMethods.shopId, shopId), eq(shopPaymentMethods.isActive, true)))
      .limit(1);
    if (!pm) throw AppError.badRequest('Payment method not found or inactive');

    if (allocations.length > 0) {
      const settlement = await settlementByPoIdsTx(tx as unknown as typeof db, poIds);
      const remainingDue = new Map<string, number>();
      for (const id of poIds) {
        remainingDue.set(id, Number(settlement.get(id)!.due));
      }

      for (const a of allocations) {
        const [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(
            and(
              eq(purchaseOrders.id, a.poId),
              eq(purchaseOrders.shopId, shopId),
              eq(purchaseOrders.supplierId, supplierId),
            ),
          )
          .limit(1);
        if (!po) {
          throw AppError.badRequest(`Purchase order ${a.poId} not found for this supplier`);
        }
        const dueLeft = remainingDue.get(a.poId) ?? 0;
        const pay = Number(a.amount);
        if (pay > dueLeft + 0.01) {
          throw AppError.badRequest(
            `Allocation for PO exceeds remaining due (PO ${a.poId.slice(0, 8)}… remaining ৳${money2(dueLeft)}, allocated ৳${money2(pay)})`,
          );
        }
        remainingDue.set(a.poId, dueLeft - pay);
      }
    }

    const [payRow] = await tx
      .insert(supplierPayments)
      .values({
        shopId,
        supplierId,
        financeAccountId: null,
        paymentMethodId: input.paymentMethodId,
        totalAmount: money2(amt),
        note: input.note ?? null,
        createdBy: userId,
      })
      .returning();

    if (!payRow) throw AppError.conflict('Payment record failed');

    for (const a of allocations) {
      await tx.insert(supplierPaymentPoAllocations).values({
        paymentId: payRow.id,
        poId: a.poId,
        amount: money2(Number(a.amount)),
      });
    }

    await tx.insert(supplierLedgerEntries).values({
      supplierId,
      entryType: 'PAYMENT',
      amount: (-amt).toFixed(2),
      refTable: 'supplier_payments',
      refId: payRow.id,
      note: input.note ?? null,
    });

    const balance = await supplierBalanceFromTx(tx as unknown as typeof db, supplierId);
    return { ok: true, balance };
  });
}

export async function getSupplierUnpaidPurchaseOrders(shopId: string, supplierId: string) {
  return listUnpaidPurchaseOrdersForSupplier(shopId, supplierId);
}

export async function getSupplierPurchaseLines(
  shopId: string,
  supplierId: string,
  limit: number,
) {
  const lines = await listSupplierPurchaseLines(shopId, supplierId, limit);
  return { lines };
}

export async function getSupplierLedger(supplierId: string, shopId: string, limit: number) {
  const [s] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.shopId, shopId)))
    .limit(1);

  if (!s) throw AppError.notFound('Supplier not found');

  const entries = await db
    .select()
    .from(supplierLedgerEntries)
    .where(eq(supplierLedgerEntries.supplierId, supplierId))
    .orderBy(desc(supplierLedgerEntries.createdAt))
    .limit(limit);

  const balance = await supplierBalanceAmount(supplierId);

  return { supplier: s, balance, entries };
}
