import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  expenseCategories,
  expenses,
  products,
  saleLines,
  sales,
} from '../db/schema/index.js';
import { getDefaultLocationId } from './stock-location.service.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import * as productService from './product.service.js';
import * as shopPaymentMethodService from './shop-payment-method.service.js';

type PgExecuteRows<T> = { rows: T[] };

export async function dashboardSummary(
  shopId: string,
  from: Date,
  to: Date,
) {
  const [agg] = await db
    .select({
      invoiceCount: sql<string>`count(*)::text`,
      grossSales: sql<string>`coalesce(sum(${sales.total}),0)::text`,
      paidTotal: sql<string>`coalesce(sum(${sales.paidTotal}),0)::text`,
      dueTotal: sql<string>`coalesce(sum(${sales.dueAmount}),0)::text`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.status, 'COMPLETED'),
        gte(sales.soldAt, from),
        lte(sales.soldAt, to),
      ),
    );

  // Wallet mix (Finance-style balances). This matches what the Finance page shows for "Cash".
  // NOTE: This is an all-time balance snapshot, not period-only.
  const paymentMix = (await shopPaymentMethodService.listPaymentMethodsWithBalances(shopId)).map(
    (m) => ({
      method: m.name,
      total: m.balance,
    }),
  );

  const [expenseAgg] = await db
    .select({
      total: sql<string>`coalesce(sum(${expenses.amount}),0)::text`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.shopId, shopId),
        gte(expenses.spentAt, from),
        lte(expenses.spentAt, to),
      ),
    );

  const [cogsAgg] = await db
    .select({
      cogs: sql<string>`coalesce(sum((${saleLines.qty})::numeric * coalesce(${saleLines.cogsUnitCost}, 0::numeric)), 0)::text`,
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.status, 'COMPLETED'),
        gte(sales.soldAt, from),
        lte(sales.soldAt, to),
      ),
    );

  const [saleRollups] = await db
    .select({
      subtotalSum: sql<string>`coalesce(sum(${sales.subtotal}),0)::text`,
      discountSum: sql<string>`coalesce(sum(${sales.discountTotal}),0)::text`,
      taxSum: sql<string>`coalesce(sum(${sales.taxTotal}),0)::text`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.status, 'COMPLETED'),
        gte(sales.soldAt, from),
        lte(sales.soldAt, to),
      ),
    );

  const [creditSalesAgg] = await db
    .select({
      count: sql<string>`count(*)::text`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.status, 'COMPLETED'),
        gte(sales.soldAt, from),
        lte(sales.soldAt, to),
        sql`${sales.dueAmount} > 0`,
      ),
    );

  const expensesByCategory = await db
    .select({
      categoryName: expenseCategories.name,
      total: sql<string>`coalesce(sum(${expenses.amount}),0)::text`,
    })
    .from(expenses)
    .innerJoin(
      expenseCategories,
      eq(expenseCategories.id, expenses.categoryId),
    )
    .where(
      and(
        eq(expenses.shopId, shopId),
        gte(expenses.spentAt, from),
        lte(expenses.spentAt, to),
      ),
    )
    .groupBy(expenseCategories.name)
    .orderBy(desc(sql`coalesce(sum(${expenses.amount}), 0::numeric)`));

  const topProducts = await db
    .select({
      productId: saleLines.productId,
      name: products.name,
      sku: products.sku,
      qtySold: sql<string>`coalesce(sum(${saleLines.qty}),0)::text`,
      revenue: sql<string>`coalesce(sum(${saleLines.lineTotal}),0)::text`,
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .innerJoin(products, eq(products.id, saleLines.productId))
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.status, 'COMPLETED'),
        gte(sales.soldAt, from),
        lte(sales.soldAt, to),
      ),
    )
    .groupBy(saleLines.productId, products.name, products.sku)
    .orderBy(desc(sql`coalesce(sum(${saleLines.lineTotal}), 0::numeric)`))
    .limit(15);

  const revenue = Number(agg?.grossSales ?? 0);
  const cogs = Number(cogsAgg?.cogs ?? 0);
  const expenseTotal = Number(expenseAgg?.total ?? 0);
  const grossProfit = revenue - cogs;
  const netEstimate = grossProfit - expenseTotal;
  const invCount = Number(agg?.invoiceCount ?? 0);
  const averageOrderValue =
    invCount > 0 ? (revenue / invCount).toFixed(2) : '0';

  const salesSeries = await db
    .select({
      day: sql<string>`to_char(timezone('Asia/Dhaka', ${sales.soldAt}), 'YYYY-MM-DD')`,
      grossSales: sql<string>`coalesce(sum(${sales.total}),0)::text`,
      invoiceCount: sql<string>`count(*)::text`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.status, 'COMPLETED'),
        gte(sales.soldAt, from),
        lte(sales.soldAt, to),
      ),
    )
    .groupBy(sql`to_char(timezone('Asia/Dhaka', ${sales.soldAt}), 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(timezone('Asia/Dhaka', ${sales.soldAt}), 'YYYY-MM-DD')`);

  // Use explicit SQL + table aliases — nested drizzle `${customers.id}` correlated to
  // `customer_ledger_entries.id` (bigint PK) and caused `uuid = bigint` at runtime.
  const totalDueRes = (await db.execute(
    sql`
      select coalesce(sum(x.bal), 0)::text as "totalDue"
      from (
        select (
          select coalesce(sum(cle.amount), 0)
          from customer_ledger_entries cle
          where cle.customer_id = c.id
        ) as bal
        from customers c
        where c.shop_id = ${shopId}::uuid
      ) x
      where x.bal > 0
    `,
  )) as unknown as PgExecuteRows<{ totalDue: string }>;
  const totalReceivableRow = { totalDue: totalDueRes.rows[0]?.totalDue ?? '0' };

  const dueCountRes = (await db.execute(
    sql`
      select count(*)::text as n
      from customers c
      where c.shop_id = ${shopId}::uuid
        and (
          select coalesce(sum(cle.amount), 0)
          from customer_ledger_entries cle
          where cle.customer_id = c.id
        ) > 0
    `,
  )) as unknown as PgExecuteRows<{ n: string }>;
  const customersWithDueCountRow = { n: dueCountRes.rows[0]?.n ?? '0' };

  const topDueRes = (await db.execute(
    sql`
      select c.id, c.name, c.phone,
        (select coalesce(sum(cle.amount), 0)::text
         from customer_ledger_entries cle
         where cle.customer_id = c.id) as balance,
        (
          select min(s.promise_pay_date)::text
          from sales s
          where s.customer_id = c.id
            and s.shop_id = c.shop_id
            and s.status = 'COMPLETED'
            and s.due_amount > 0
            and s.promise_pay_date is not null
        ) as earliest_promise_pay_date
      from customers c
      where c.shop_id = ${shopId}::uuid
        and (
          select coalesce(sum(cle2.amount), 0)
          from customer_ledger_entries cle2
          where cle2.customer_id = c.id
        ) > 0
      order by
        coalesce(
          (
            select min(s2.promise_pay_date)
            from sales s2
            where s2.customer_id = c.id
              and s2.shop_id = c.shop_id
              and s2.status = 'COMPLETED'
              and s2.due_amount > 0
              and s2.promise_pay_date is not null
          ),
          '9999-12-31'::date
        ) asc,
        (
          select coalesce(sum(cle3.amount), 0)
          from customer_ledger_entries cle3
          where cle3.customer_id = c.id
        ) desc
      limit 8
    `,
  )) as unknown as PgExecuteRows<{
    id: string;
    name: string;
    phone: string;
    balance: string;
    earliest_promise_pay_date: string | null;
  }>;
  const topDueCustomers = topDueRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    balance: r.balance,
    earliestPromisePayDate: r.earliest_promise_pay_date,
  }));

  let inventoryAlerts: Array<{
    productId: string;
    name: string;
    sku: string;
    trackingMode: string;
    quantityOnHand: string;
    minStockLevel: number;
    alert: 'EMPTY' | 'LOW';
  }> = [];

  try {
    // Single source of truth: reuse the same stock calculation used by GET /products.
    // Dashboard only needs top N alerts; it should not run an independent stock computation.
    // NOTE: This is not as efficient as a dedicated alert query, but guarantees consistency.
    await getDefaultLocationId(shopId); // sanity check default location exists
    await isMultiStockLocationEnabled(shopId); // pre-warm settings read (also validates shop row exists)

    const list = await productService.listProducts(shopId, {
      active: true,
      inventoryTracked: true,
      limit: 500,
      offset: 0,
    });

    for (const p of list) {
      const q = Number((p as any).quantityOnHand ?? 0);
      const min = Number((p as any).minStockLevel ?? 0);
      if (!Number.isFinite(q) || !Number.isFinite(min)) continue;
      if (q > min) continue;
      inventoryAlerts.push({
        productId: (p as any).id,
        name: (p as any).name,
        sku: (p as any).sku,
        trackingMode: (p as any).trackingMode,
        quantityOnHand: String((p as any).quantityOnHand ?? '0'),
        minStockLevel: (p as any).minStockLevel,
        alert: q <= 0 ? 'EMPTY' : 'LOW',
      });
    }

    inventoryAlerts.sort((a, b) => {
      if (a.alert !== b.alert) return a.alert === 'EMPTY' ? -1 : 1;
      return Number(a.quantityOnHand) - Number(b.quantityOnHand);
    });
    inventoryAlerts = inventoryAlerts.slice(0, 10);
  } catch {
    inventoryAlerts = [];
  }

  return {
    range: { from, to },
    sales: {
      invoiceCount: invCount,
      grossSales: agg?.grossSales ?? '0',
      paidTotal: agg?.paidTotal ?? '0',
      dueTotal: agg?.dueTotal ?? '0',
    },
    salesRollup: {
      subtotalSum: saleRollups?.subtotalSum ?? '0',
      discountSum: saleRollups?.discountSum ?? '0',
      taxSum: saleRollups?.taxSum ?? '0',
      invoicesWithDue: Number(creditSalesAgg?.count ?? 0),
      averageOrderValue,
    },
    paymentMix,
    expensesTotal: expenseAgg?.total ?? '0',
    expensesByCategory,
    topProducts,
    cogs: cogsAgg?.cogs ?? '0',
    grossProfit: grossProfit.toFixed(2),
    netProfitEstimate: netEstimate.toFixed(2),
    salesSeries,
    receivables: {
      totalDue: totalReceivableRow?.totalDue ?? '0',
      customersWithDue: Number(customersWithDueCountRow?.n ?? 0),
      topCustomers: topDueCustomers,
    },
    inventoryAlerts,
  };
}

export async function profitAndLoss(
  shopId: string,
  from: Date,
  to: Date,
) {
  return dashboardSummary(shopId, from, to);
}
