import { and, asc, count, desc, eq, gt, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  customerAccounts,
  customerLedgerEntries,
  customers,
  salePayments,
  sales,
  shopPaymentMethods,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { getMoneyReceiptAllocationMethodId } from './shop-payment-method.service.js';

export function normalizeBdPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `880${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('1')) return `880${digits}`;
  return digits;
}

async function customerBalance(customerId: string): Promise<string> {
  const [agg] = await db
    .select({
      sum: sql<string>`coalesce(sum(${customerLedgerEntries.amount}),0)::text`,
    })
    .from(customerLedgerEntries)
    .where(eq(customerLedgerEntries.customerId, customerId));
  return agg?.sum ?? '0';
}

export async function listCustomers(
  shopId: string,
  q: { search?: string; limit: number; offset: number; dueOnly?: boolean },
) {
  const conditions = [eq(customers.shopId, shopId)];

  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    const phone = normalizeBdPhone(q.search.trim());
    conditions.push(
      or(
        ilike(customers.name, s),
        ilike(customers.phone, s),
        eq(customers.phone, phone),
      )!,
    );
  }

  if (q.dueOnly) {
    conditions.push(
      sql`(select coalesce(sum(${customerLedgerEntries.amount}), 0)::numeric from ${customerLedgerEntries} where ${customerLedgerEntries.customerId} = ${customers.id}) > 0`,
    );
  }

  const rows = await db
    .select({
      id: customers.id,
      shopId: customers.shopId,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
      address: customers.address,
      notes: customers.notes,
      createdAt: customers.createdAt,
      updatedAt: customers.updatedAt,
      hasWebsiteAccount: sql<boolean>`exists (
        select 1 from ${customerAccounts} ca
        where ca.customer_id = ${customers.id} and ca.shop_id = ${customers.shopId}
      )`,
    })
    .from(customers)
    .where(and(...conditions))
    .orderBy(desc(customers.createdAt))
    .limit(q.limit)
    .offset(q.offset);

  const withBal = [];
  for (const c of rows) {
    withBal.push({ ...c, balance: await customerBalance(c.id) });
  }
  return withBal;
}

export async function createCustomer(
  shopId: string,
  input: {
    name: string;
    phone: string;
    email?: string | null;
    address?: string | null;
    notes?: string | null;
  },
) {
  const phone = normalizeBdPhone(input.phone);

  const [dup] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.shopId, shopId), eq(customers.phone, phone)))
    .limit(1);
  if (dup) throw AppError.duplicateCustomerPhone();

  try {
    const [row] = await db
      .insert(customers)
      .values({
        shopId,
        name: input.name.trim(),
        phone,
        email: input.email?.trim() ? input.email.trim() : null,
        address: input.address?.trim() ? input.address.trim() : null,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      })
      .returning();

    if (!row) throw AppError.conflict('Could not create customer');
    return row;
  } catch (err: unknown) {
    const e = err as { code?: string; constraint?: string };
    if (
      e?.code === '23505' &&
      String(e?.constraint ?? '').includes('customers_shop_id_phone')
    ) {
      throw AppError.duplicateCustomerPhone();
    }
    throw err;
  }
}

/** Completed sales with open balance for this customer (oldest first). */
export async function listCustomerOpenDueSales(shopId: string, customerId: string) {
  const [c] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.shopId, shopId)))
    .limit(1);

  if (!c) throw AppError.notFound('Customer not found');

  return db
    .select({
      id: sales.id,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
      total: sales.total,
      paidTotal: sales.paidTotal,
      dueAmount: sales.dueAmount,
      promisePayDate: sales.promisePayDate,
    })
    .from(sales)
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.customerId, customerId),
        eq(sales.status, 'COMPLETED'),
        gt(sales.dueAmount, '0'),
      ),
    )
    .orderBy(asc(sales.soldAt));
}

function moneyEps(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.02;
}

export async function recordCustomerPayment(
  shopId: string,
  customerId: string,
  input: {
    amount: string;
    note?: string;
    /** When set, apply payment only to these sales; amounts must sum to `amount`. */
    allocations?: { saleId: string; amount: string }[] | null;
  },
) {
  const [c] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.shopId, shopId)))
    .limit(1);

  if (!c) throw AppError.notFound('Customer not found');

  const amt = Number(input.amount);
  if (amt <= 0) throw AppError.badRequest('Amount must be positive');

  const balance = Number(await customerBalance(customerId));
  if (!Number.isFinite(balance) || amt > balance + 0.02) {
    throw AppError.badRequest('Amount exceeds customer outstanding balance');
  }

  const note = input.note ?? 'Payment received';

  const mrMethodId = await getMoneyReceiptAllocationMethodId(shopId);
  const [pmMeta] = await db
    .select({ name: shopPaymentMethods.name })
    .from(shopPaymentMethods)
    .where(eq(shopPaymentMethods.id, mrMethodId))
    .limit(1);
  const methodLabelSnapshot = pmMeta?.name ?? 'Other';

  const rawAlloc = input.allocations?.filter((a) => a.saleId && String(a.amount ?? '').trim() !== '') ?? [];
  const useExplicit = rawAlloc.length > 0;

  if (useExplicit) {
    const seen = new Set<string>();
    for (const a of rawAlloc) {
      if (seen.has(a.saleId)) {
        throw AppError.badRequest('Duplicate sale in allocations');
      }
      seen.add(a.saleId);
    }
  }

  const out = await db.transaction(async (tx) => {
    const [le] = await tx
      .insert(customerLedgerEntries)
      .values({
        customerId,
        entryType: 'PAYMENT',
        amount: (-amt).toFixed(2),
        note,
        refTable: 'money_receipt',
        refId: null,
      })
      .returning();

    if (!le) throw AppError.conflict('Could not record payment');

    const allocations: Array<{ saleId: string; invoiceNo: string; amount: string }> = [];

    if (useExplicit) {
      let sumAlloc = 0;
      const rows: Array<{ sale: typeof sales.$inferSelect; apply: number }> = [];

      for (const a of rawAlloc) {
        const apply = Number(a.amount);
        if (!Number.isFinite(apply) || apply <= 0) {
          throw AppError.badRequest('Each allocation amount must be greater than 0');
        }

        const [s] = await tx
          .select()
          .from(sales)
          .where(
            and(
              eq(sales.id, a.saleId),
              eq(sales.shopId, shopId),
              eq(sales.customerId, customerId),
              eq(sales.status, 'COMPLETED'),
              gt(sales.dueAmount, '0'),
            ),
          )
          .limit(1);

        if (!s) {
          throw AppError.badRequest('Invalid or ineligible sale in allocations', {
            saleId: a.saleId,
          });
        }

        const due = Number(s.dueAmount);
        if (apply > due + 0.02) {
          throw AppError.badRequest('Allocation exceeds invoice balance due', {
            invoiceNo: s.invoiceNo,
            due: due.toFixed(2),
            requested: apply.toFixed(2),
          });
        }

        sumAlloc += apply;
        rows.push({ sale: s, apply });
      }

      if (!moneyEps(sumAlloc, amt)) {
        throw AppError.badRequest('Allocations must sum to the payment amount', {
          sumAlloc: sumAlloc.toFixed(2),
          paymentAmount: amt.toFixed(2),
        });
      }

      for (const { sale: s, apply } of rows) {
        const applyStr = apply.toFixed(2);
        await tx.insert(salePayments).values({
          saleId: s.id,
          paymentMethodId: mrMethodId,
          methodLabelSnapshot,
          amount: applyStr,
          providerReference: `MR-${le.id}`,
        });

        await tx
          .update(sales)
          .set({
            paidTotal: sql`${sales.paidTotal} + ${applyStr}`,
            dueAmount: sql`greatest(${sales.dueAmount} - ${applyStr}, 0)`,
          })
          .where(and(eq(sales.id, s.id), eq(sales.shopId, shopId)));

        allocations.push({ saleId: s.id, invoiceNo: s.invoiceNo, amount: applyStr });
      }
    } else {
      let remaining = amt;

      const dueSales = await tx
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.shopId, shopId),
            eq(sales.customerId, customerId),
            eq(sales.status, 'COMPLETED'),
            gt(sales.dueAmount, '0'),
          ),
        )
        .orderBy(asc(sales.soldAt))
        .limit(200);

      for (const s of dueSales) {
        if (remaining <= 0) break;
        const due = Number(s.dueAmount);
        if (!Number.isFinite(due) || due <= 0) continue;
        const apply = Math.min(remaining, due);
        if (apply <= 0) continue;

        await tx.insert(salePayments).values({
          saleId: s.id,
          paymentMethodId: mrMethodId,
          methodLabelSnapshot,
          amount: apply.toFixed(2),
          providerReference: `MR-${le.id}`,
        });

        await tx
          .update(sales)
          .set({
            paidTotal: sql`${sales.paidTotal} + ${apply.toFixed(2)}`,
            dueAmount: sql`greatest(${sales.dueAmount} - ${apply.toFixed(2)}, 0)`,
          })
          .where(and(eq(sales.id, s.id), eq(sales.shopId, shopId)));

        allocations.push({ saleId: s.id, invoiceNo: s.invoiceNo, amount: apply.toFixed(2) });
        remaining -= apply;
      }
    }

    return { ledgerId: le.id, allocations };
  });

  return {
    ok: true,
    balance: await customerBalance(customerId),
    receiptId: out.ledgerId,
    allocations: out.allocations,
  };
}

export async function updateCustomer(
  shopId: string,
  customerId: string,
  input: {
    name: string;
    phone: string;
    email?: string | null;
    address?: string | null;
    notes?: string | null;
  },
) {
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.shopId, shopId)))
    .limit(1);

  if (!existing) throw AppError.notFound('Customer not found');

  const phone = normalizeBdPhone(input.phone);
  if (phone !== existing.phone) {
    const [dup] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.shopId, shopId), eq(customers.phone, phone)))
      .limit(1);
    if (dup) throw AppError.conflict('Phone already exists for another customer');
  }

  const [row] = await db
    .update(customers)
    .set({
      name: input.name.trim(),
      phone,
      email: input.email?.trim() ? input.email.trim() : null,
      address: input.address?.trim() ?? null,
      notes: input.notes?.trim() ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, customerId), eq(customers.shopId, shopId)))
    .returning();

  if (!row) throw AppError.notFound('Customer not found');
  return { ...row, balance: await customerBalance(customerId) };
}

export async function listMoneyReceipts(
  shopId: string,
  q: { search?: string; from?: Date; to?: Date; limit: number; offset: number },
) {
  const conditions: any[] = [eq(customers.shopId, shopId), eq(customerLedgerEntries.entryType, 'PAYMENT')];
  if (q.from) conditions.push(sql`${customerLedgerEntries.createdAt} >= ${q.from}`);
  if (q.to) conditions.push(sql`${customerLedgerEntries.createdAt} <= ${q.to}`);
  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    const phone = normalizeBdPhone(q.search.trim());
    conditions.push(or(ilike(customers.name, s), ilike(customers.phone, s), eq(customers.phone, phone))!);
  }

  const whereClause = and(...conditions);

  const [countRow] = await db
    .select({ total: count() })
    .from(customerLedgerEntries)
    .innerJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
    .where(whereClause);

  const rows = await db
    .select({
      ledgerId: customerLedgerEntries.id,
      createdAt: customerLedgerEntries.createdAt,
      amount: customerLedgerEntries.amount,
      note: customerLedgerEntries.note,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(customerLedgerEntries)
    .innerJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
    .where(whereClause)
    .orderBy(desc(customerLedgerEntries.createdAt))
    .limit(q.limit)
    .offset(q.offset);

  const items = rows.map((r) => ({
    ledgerId: r.ledgerId,
    createdAt: r.createdAt,
    amountReceived: Math.abs(Number(r.amount)).toFixed(2),
    note: r.note ?? null,
    customer: { id: r.customerId, name: r.customerName, phone: r.customerPhone },
    // Frontend print page (no backend file generation).
    publicPath: `/receipts/${r.ledgerId}`,
  }));

  return { items, total: Number(countRow?.total ?? 0) };
}

export async function getMoneyReceiptDetail(shopId: string, ledgerId: number) {
  const [row] = await db
    .select({
      ledgerId: customerLedgerEntries.id,
      entryType: customerLedgerEntries.entryType,
      amount: customerLedgerEntries.amount,
      note: customerLedgerEntries.note,
      createdAt: customerLedgerEntries.createdAt,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(customerLedgerEntries)
    .innerJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
    .where(
      and(
        eq(customers.shopId, shopId),
        eq(customerLedgerEntries.id, ledgerId),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound('Receipt not found');
  if (row.entryType !== 'PAYMENT') throw AppError.conflict('Not a payment receipt');

  const allocations = await db
    .select({
      saleId: sales.id,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
      amount: salePayments.amount,
    })
    .from(salePayments)
    .innerJoin(sales, eq(sales.id, salePayments.saleId))
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.customerId, row.customerId),
        eq(salePayments.providerReference, `MR-${ledgerId}`),
      ),
    )
    .orderBy(asc(sales.soldAt));

  return {
    receipt: {
      ledgerId: row.ledgerId,
      createdAt: row.createdAt,
      note: row.note ?? null,
      amountReceived: Math.abs(Number(row.amount)).toFixed(2),
    },
    customer: { id: row.customerId, name: row.customerName, phone: row.customerPhone },
    allocations: allocations.map((a) => ({
      saleId: a.saleId,
      invoiceNo: a.invoiceNo,
      soldAt: a.soldAt,
      amount: a.amount,
    })),
  };
}

export async function getMoneyReceiptDetailPublic(ledgerId: number) {
  const [row] = await db
    .select({
      ledgerId: customerLedgerEntries.id,
      entryType: customerLedgerEntries.entryType,
      amount: customerLedgerEntries.amount,
      note: customerLedgerEntries.note,
      createdAt: customerLedgerEntries.createdAt,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(customerLedgerEntries)
    .innerJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
    .where(eq(customerLedgerEntries.id, ledgerId))
    .limit(1);

  if (!row) throw AppError.notFound('Receipt not found');
  if (row.entryType !== 'PAYMENT') throw AppError.conflict('Not a payment receipt');

  const allocations = await db
    .select({
      saleId: sales.id,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
      amount: salePayments.amount,
    })
    .from(salePayments)
    .innerJoin(sales, eq(sales.id, salePayments.saleId))
    .where(
      and(
        eq(sales.customerId, row.customerId),
        eq(salePayments.providerReference, `MR-${ledgerId}`),
      ),
    )
    .orderBy(asc(sales.soldAt));

  return {
    receipt: {
      ledgerId: row.ledgerId,
      createdAt: row.createdAt,
      note: row.note ?? null,
      amountReceived: Math.abs(Number(row.amount)).toFixed(2),
    },
    customer: { id: row.customerId, name: row.customerName, phone: row.customerPhone },
    allocations: allocations.map((a) => ({
      saleId: a.saleId,
      invoiceNo: a.invoiceNo,
      soldAt: a.soldAt,
      amount: a.amount,
    })),
  };
}
