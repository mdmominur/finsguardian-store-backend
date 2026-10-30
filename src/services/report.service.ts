import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  expenseCategories,
  expenses,
} from '../db/schema/index.js';
import { getOrComputeShopCache } from '../lib/shop-cache.js';
import { getDefaultLocationId } from './stock-location.service.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import * as shopPaymentMethodService from './shop-payment-method.service.js';

type PgExecuteRows<T> = { rows: T[] };

const CACHE_TTL_MS = 60_000;

/**
 * Fast period-based sales, profit, expense total, and daily trend series.
 * Runs all independent aggregations in parallel (`Promise.all`).
 */
export async function dashboardMetrics(
  shopId: string,
  from: Date,
  to: Date,
) {
  const cacheKey = `dashboard:metrics:${from.toISOString()}:${to.toISOString()}`;
  return getOrComputeShopCache(shopId, cacheKey, CACHE_TTL_MS, async () => {
    const [salesAggRes, expenseAggRows, cogsRes, salesSeriesRes] = await Promise.all([
      db.execute(sql`
        with sales_in_range as (
          select
            s.id,
            s.status,
            s.subtotal::numeric as subtotal,
            s.discount_total::numeric as discount_total,
            s.tax_total::numeric as tax_total,
            s.total::numeric as total,
            s.paid_total::numeric as paid_total,
            s.due_amount::numeric as due_amount
          from sales s
          where s.shop_id = ${shopId}::uuid
            and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
            and s.sold_at >= ${from}
            and s.sold_at <= ${to}
        ),
        refund_lines_by_sale as (
          select
            r.sale_id,
            coalesce(sum(rl.amount::numeric), 0) as line_refunded
          from refunds r
          inner join sales_in_range sir on sir.id = r.sale_id
          inner join refund_lines rl on rl.refund_id = r.id
          where r.shop_id = ${shopId}::uuid
          group by r.sale_id
        ),
        refund_payout_by_sale as (
          select
            r.sale_id,
            coalesce(sum(r.payout_amount::numeric), 0) as payout
          from refunds r
          inner join sales_in_range sir on sir.id = r.sale_id
          where r.shop_id = ${shopId}::uuid
          group by r.sale_id
        )
        select
          count(*)::text as "invoiceCount",
          (
            coalesce(sum(s.total), 0)
            - coalesce(sum(rls.line_refunded), 0)
          )::text as "grossSales",
          (
            coalesce(sum(s.paid_total), 0)
            - coalesce(sum(rps.payout), 0)
          )::text as "paidTotal",
          coalesce(sum(s.due_amount), 0)::text as "dueTotal",
          coalesce(sum(s.subtotal), 0)::text as "subtotalSum",
          coalesce(sum(s.discount_total), 0)::text as "discountSum",
          coalesce(sum(s.tax_total), 0)::text as "taxSum",
          count(*) filter (
            where s.status in ('COMPLETED', 'PARTIALLY_REFUNDED') and s.due_amount > 0
          )::text as "invoicesWithDue"
        from sales_in_range s
        left join refund_lines_by_sale rls on rls.sale_id = s.id
        left join refund_payout_by_sale rps on rps.sale_id = s.id
      `) as unknown as Promise<
        PgExecuteRows<{
          invoiceCount: string;
          grossSales: string;
          paidTotal: string;
          dueTotal: string;
          subtotalSum: string;
          discountSum: string;
          taxSum: string;
          invoicesWithDue: string;
        }>
      >,

      db
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
        ),

      db.execute(sql`
        with sales_in_range as (
          select s.id
          from sales s
          where s.shop_id = ${shopId}::uuid
            and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
            and s.sold_at >= ${from}
            and s.sold_at <= ${to}
        ),
        refunded_qty as (
          select
            rl.sale_line_id,
            coalesce(sum(rl.qty::numeric), 0) as qty
          from refund_lines rl
          inner join refunds r on r.id = rl.refund_id
          inner join sales_in_range sir on sir.id = r.sale_id
          where r.shop_id = ${shopId}::uuid
          group by rl.sale_line_id
        )
        select coalesce(
          sum(
            greatest(sl.qty::numeric - coalesce(rq.qty, 0), 0)
            * coalesce(sl.cogs_unit_cost, 0::numeric)
          ),
          0
        )::text as cogs
        from sale_lines sl
        inner join sales_in_range s on s.id = sl.sale_id
        left join refunded_qty rq on rq.sale_line_id = sl.id
      `) as unknown as Promise<PgExecuteRows<{ cogs: string }>>,

      db.execute(sql`
        with sales_in_range as (
          select s.id, s.sold_at, s.total::numeric as total
          from sales s
          where s.shop_id = ${shopId}::uuid
            and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
            and s.sold_at >= ${from}
            and s.sold_at <= ${to}
        ),
        refund_lines_by_sale as (
          select
            r.sale_id,
            coalesce(sum(rl.amount::numeric), 0) as line_refunded
          from refunds r
          inner join sales_in_range sir on sir.id = r.sale_id
          inner join refund_lines rl on rl.refund_id = r.id
          where r.shop_id = ${shopId}::uuid
          group by r.sale_id
        )
        select
          to_char(timezone('Asia/Dhaka', s.sold_at), 'YYYY-MM-DD') as day,
          (
            coalesce(sum(s.total), 0)
            - coalesce(sum(rls.line_refunded), 0)
          )::text as "grossSales",
          count(*)::text as "invoiceCount"
        from sales_in_range s
        left join refund_lines_by_sale rls on rls.sale_id = s.id
        group by to_char(timezone('Asia/Dhaka', s.sold_at), 'YYYY-MM-DD')
        order by to_char(timezone('Asia/Dhaka', s.sold_at), 'YYYY-MM-DD')
      `) as unknown as Promise<
        PgExecuteRows<{
          day: string;
          grossSales: string;
          invoiceCount: string;
        }>
      >,
    ]);

    const agg = salesAggRes.rows[0];
    const expenseAgg = expenseAggRows[0];
    const cogsAgg = cogsRes.rows[0];
    const salesSeries = salesSeriesRes.rows;

    const revenue = Number(agg?.grossSales ?? 0);
    const cogs = Number(cogsAgg?.cogs ?? 0);
    const expenseTotal = Number(expenseAgg?.total ?? 0);
    const grossProfit = revenue - cogs;
    const netEstimate = grossProfit - expenseTotal;
    const invCount = Number(agg?.invoiceCount ?? 0);
    const averageOrderValue = invCount > 0 ? (revenue / invCount).toFixed(2) : '0';

    return {
      range: { from, to },
      sales: {
        invoiceCount: invCount,
        grossSales: agg?.grossSales ?? '0',
        paidTotal: agg?.paidTotal ?? '0',
        dueTotal: agg?.dueTotal ?? '0',
      },
      salesRollup: {
        subtotalSum: agg?.subtotalSum ?? '0',
        discountSum: agg?.discountSum ?? '0',
        taxSum: agg?.taxSum ?? '0',
        invoicesWithDue: Number(agg?.invoicesWithDue ?? 0),
        averageOrderValue,
      },
      expensesTotal: expenseAgg?.total ?? '0',
      cogs: cogsAgg?.cogs ?? '0',
      grossProfit: grossProfit.toFixed(2),
      netProfitEstimate: netEstimate.toFixed(2),
      salesSeries,
    };
  });
}

/**
 * All-time customer receivables snapshot (single CTE query instead of 3 correlated-subquery scans).
 */
export async function dashboardReceivables(shopId: string) {
  return getOrComputeShopCache(shopId, 'dashboard:receivables', CACHE_TTL_MS, async () => {
    const [res, paymentMethods] = await Promise.all([
      db.execute(sql`
        with customer_balances as (
          select
            c.id,
            c.name,
            c.phone,
            coalesce(sum(cle.amount), 0) as bal
          from customers c
          inner join customer_ledger_entries cle on cle.customer_id = c.id
          where c.shop_id = ${shopId}::uuid
          group by c.id, c.name, c.phone
          having coalesce(sum(cle.amount), 0) > 0
        ),
        totals as (
          select
            coalesce(sum(bal), 0)::text as total_due,
            count(*)::int as customers_with_due
          from customer_balances
        ),
        top_due as (
          select
            cb.id,
            cb.name,
            cb.phone,
            cb.bal::text as balance,
            min(s.promise_pay_date)::text as "earliestPromisePayDate"
          from customer_balances cb
          left join sales s
            on s.customer_id = cb.id
           and s.shop_id = ${shopId}::uuid
           and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED')
           and s.due_amount > 0
           and s.promise_pay_date is not null
          group by cb.id, cb.name, cb.phone, cb.bal
          order by
            coalesce(min(s.promise_pay_date), '9999-12-31'::date) asc,
            cb.bal desc
          limit 8
        )
        select
          t.total_due as "totalDue",
          t.customers_with_due as "customersWithDue",
          coalesce(
            (select json_agg(row_to_json(td)) from top_due td),
            '[]'::json
          ) as "topCustomers"
        from totals t
      `) as unknown as Promise<
        PgExecuteRows<{
          totalDue: string;
          customersWithDue: number;
          topCustomers: Array<{
            id: string;
            name: string;
            phone: string;
            balance: string;
            earliestPromisePayDate: string | null;
          }>;
        }>
      >,
      shopPaymentMethodService.listPaymentMethodsWithBalances(shopId),
    ]);

    const row = res.rows[0];
    const paymentMix = paymentMethods.map((m) => ({
      method: m.name,
      total: m.balance,
    }));

    return {
      totalDue: row?.totalDue ?? '0',
      customersWithDue: Number(row?.customersWithDue ?? 0),
      topCustomers: row?.topCustomers ?? [],
      paymentMix,
    };
  });
}

/**
 * Low / empty stock alerts computed in a single SQL query (replaces 500+ N+1 queries).
 */
export async function dashboardInventoryAlerts(shopId: string) {
  return getOrComputeShopCache(shopId, 'dashboard:inventoryAlerts', CACHE_TTL_MS, async () => {
    try {
      const [defaultLocId, multiLoc] = await Promise.all([
        getDefaultLocationId(shopId),
        isMultiStockLocationEnabled(shopId),
      ]);

      const serializedLocationFilter = multiLoc
        ? sql`and (du.stock_location_id = ${defaultLocId}::uuid or du.stock_location_id is null)`
        : sql``;

      const res = (await db.execute(sql`
        with serialized_counts as (
          select
            du.product_id,
            count(*)::numeric as cnt
          from device_units du
          where du.shop_id = ${shopId}::uuid
            and du.status = 'IN_STOCK'
            and du.blocklisted = false
            ${serializedLocationFilter}
          group by du.product_id
        ),
        product_stock as (
          select
            p.id as "productId",
            p.name,
            p.sku,
            p.tracking_mode as "trackingMode",
            case
              when p.tracking_mode = 'QUANTITY' then coalesce(ib.quantity::numeric, 0)
              else coalesce(sc.cnt, 0)
            end as on_hand_num,
            case
              when p.tracking_mode = 'QUANTITY' then coalesce(ib.quantity::text, '0')
              else coalesce(sc.cnt::text, '0')
            end as "quantityOnHand",
            coalesce(p.min_stock_level::numeric, 0) as min_num,
            p.min_stock_level as "minStockLevel"
          from products p
          left join inventory_balances ib
            on ib.shop_id = p.shop_id
           and ib.product_id = p.id
           and ib.location_id = ${defaultLocId}::uuid
          left join serialized_counts sc
            on sc.product_id = p.id
          where p.shop_id = ${shopId}::uuid
            and p.active = true
            and (p.tracking_mode = 'SERIALIZED' or p.inventory_tracked = true)
        )
        select
          "productId",
          name,
          sku,
          "trackingMode",
          "quantityOnHand",
          "minStockLevel",
          case when on_hand_num <= 0 then 'EMPTY' else 'LOW' end as alert
        from product_stock
        where on_hand_num <= min_num
        order by
          case when on_hand_num <= 0 then 0 else 1 end asc,
          on_hand_num asc,
          lower(name) asc
        limit 10
      `)) as unknown as PgExecuteRows<{
        productId: string;
        name: string;
        sku: string;
        trackingMode: string;
        quantityOnHand: string;
        minStockLevel: number;
        alert: 'EMPTY' | 'LOW';
      }>;

      return res.rows.map((r) => ({
        ...r,
        minStockLevel: Number(r.minStockLevel ?? 0),
      }));
    } catch {
      return [];
    }
  });
}

/**
 * Full dashboard / P&L report summary (executes all slices in parallel).
 */
export async function dashboardSummary(
  shopId: string,
  from: Date,
  to: Date,
) {
  const cacheKey = `dashboard:full:${from.toISOString()}:${to.toISOString()}`;
  return getOrComputeShopCache(shopId, cacheKey, CACHE_TTL_MS, async () => {
    const [
      metrics,
      receivablesData,
      inventoryAlerts,
      expensesByCategory,
      topProductsRes,
    ] = await Promise.all([
      dashboardMetrics(shopId, from, to),
      dashboardReceivables(shopId),
      dashboardInventoryAlerts(shopId),
      db
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
        .orderBy(desc(sql`coalesce(sum(${expenses.amount}), 0::numeric)`)),
      db.execute(sql`
        with sales_in_range as (
          select s.id
          from sales s
          where s.shop_id = ${shopId}::uuid
            and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
            and s.sold_at >= ${from}
            and s.sold_at <= ${to}
        ),
        refunded_by_line as (
          select
            rl.sale_line_id,
            coalesce(sum(rl.qty::numeric), 0) as refunded_qty,
            coalesce(sum(rl.amount::numeric), 0) as refunded_amount
          from refund_lines rl
          inner join refunds r on r.id = rl.refund_id
          inner join sales_in_range sir on sir.id = r.sale_id
          where r.shop_id = ${shopId}::uuid
          group by rl.sale_line_id
        )
        select
          sl.product_id as "productId",
          p.name,
          p.sku,
          coalesce(
            sum(greatest(sl.qty::numeric - coalesce(rbl.refunded_qty, 0), 0)),
            0
          )::text as "qtySold",
          coalesce(
            sum(greatest(sl.line_total::numeric - coalesce(rbl.refunded_amount, 0), 0)),
            0
          )::text as revenue
        from sale_lines sl
        inner join sales_in_range s on s.id = sl.sale_id
        inner join products p on p.id = sl.product_id
        left join refunded_by_line rbl on rbl.sale_line_id = sl.id
        group by sl.product_id, p.name, p.sku
        having coalesce(
          sum(greatest(sl.line_total::numeric - coalesce(rbl.refunded_amount, 0), 0)),
          0
        ) > 0
        order by coalesce(
          sum(greatest(sl.line_total::numeric - coalesce(rbl.refunded_amount, 0), 0)),
          0
        ) desc
        limit 15
      `) as unknown as Promise<
        PgExecuteRows<{
          productId: string;
          name: string;
          sku: string;
          qtySold: string;
          revenue: string;
        }>
      >,
    ]);

    const { paymentMix, ...receivables } = receivablesData;

    return {
      ...metrics,
      paymentMix,
      expensesByCategory,
      topProducts: topProductsRes.rows,
      receivables,
      inventoryAlerts,
    };
  });
}

export async function profitAndLoss(
  shopId: string,
  from: Date,
  to: Date,
) {
  return dashboardSummary(shopId, from, to);
}
