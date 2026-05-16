import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  customers,
  products,
  saleLines,
  salePayments,
  sales,
  shopPaymentMethods,
  shops,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

const STORAGE_DIR = join(process.cwd(), 'storage', 'invoices');

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBDT(n: string | number) {
  const x = typeof n === 'number' ? n : Number(n);
  const safe = Number.isFinite(x) ? x : 0;
  return new Intl.NumberFormat('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(safe);
}

export async function ensureInvoiceHtml(shopId: string, saleId: string) {
  await mkdir(STORAGE_DIR, { recursive: true });
  const filePath = join(STORAGE_DIR, `${saleId}.html`);

  // If already exists, reuse.
  try {
    await readFile(filePath, 'utf8');
    return { filePath, publicPath: `/public/invoices/${saleId}` };
  } catch {
    // generate
  }

  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw AppError.notFound('Shop not found');

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.shopId, shopId)))
    .limit(1);
  if (!sale) throw AppError.notFound('Sale not found');

  const [customer] = sale.customerId
    ? await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, sale.customerId), eq(customers.shopId, shopId)))
        .limit(1)
    : [null];

  const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, saleId));
  const payments = await db
    .select({
      amount: salePayments.amount,
      methodLabel: sql<string>`coalesce(${salePayments.methodLabelSnapshot}, ${shopPaymentMethods.name})`,
    })
    .from(salePayments)
    .leftJoin(shopPaymentMethods, eq(shopPaymentMethods.id, salePayments.paymentMethodId))
    .where(eq(salePayments.saleId, saleId));

  const productIds = Array.from(new Set(lines.map((l) => l.productId)));
  const productRows = productIds.length
    ? await db
        .select({ id: products.id, sku: products.sku, name: products.name })
        .from(products)
        .where(and(eq(products.shopId, shopId), inArray(products.id, productIds)))
    : [];
  const prodMap = new Map(productRows.map((p) => [p.id, p]));

  const itemsHtml = lines
    .map((l, idx) => {
      const p = prodMap.get(l.productId);
      const title = p ? `${p.name}` : l.description ? l.description : 'Item';
      const sku = p?.sku ?? '';
      return `<tr>
  <td class="c1">${idx + 1}</td>
  <td class="c2">
    <div class="name">${escapeHtml(title)}</div>
    ${sku ? `<div class="sku">${escapeHtml(sku)}</div>` : ''}
    ${l.deviceUnitId ? `<div class="meta">Serialized</div>` : ''}
  </td>
  <td class="c3">${escapeHtml(String(l.qty))}</td>
  <td class="c4">৳ ${escapeHtml(formatBDT(l.unitPrice))}</td>
  <td class="c5">৳ ${escapeHtml(formatBDT(l.discount))}</td>
  <td class="c6">৳ ${escapeHtml(formatBDT(l.lineTotal))}</td>
</tr>`;
    })
    .join('\n');

  const paymentsHtml = payments.length
    ? payments
        .map(
          (p) => `<div class="row">
  <div class="k">${escapeHtml(p.methodLabel)}</div>
  <div class="v">৳ ${escapeHtml(formatBDT(p.amount))}</div>
</div>`,
        )
        .join('\n')
    : `<div class="row"><div class="k">—</div><div class="v">No payments</div></div>`;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Invoice ${escapeHtml(sale.invoiceNo)}</title>
    <style>
      :root { --ink:#111; --muted:#666; --line:#e6e6e6; }
      @page { size: A4; margin: 14mm; }
      body { font-family: Arial, Helvetica, sans-serif; color: var(--ink); }
      .top { display:flex; justify-content:space-between; gap: 16px; align-items:flex-start; }
      .brand { font-size: 18px; font-weight: 800; }
      .muted { color: var(--muted); font-size: 12px; line-height: 1.4; }
      .inv { text-align:right; }
      .inv .no { font-size: 16px; font-weight: 800; }
      .box { border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
      .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .row { display:flex; justify-content:space-between; gap: 12px; font-size: 12px; padding: 3px 0; }
      .k { color: var(--muted); }
      .v { font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      thead th { background:#f6f6f6; border: 1px solid var(--line); padding: 8px; font-size: 12px; text-align:left; }
      tbody td { border: 1px solid var(--line); padding: 8px; font-size: 12px; vertical-align: top; }
      .c1 { width: 34px; text-align:center; }
      .c3 { width: 70px; text-align:right; }
      .c4,.c5,.c6 { width: 90px; text-align:right; }
      .name { font-weight: 700; }
      .sku { font-size: 11px; color: var(--muted); margin-top: 2px; }
      .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
      .totals { margin-top: 12px; display:grid; grid-template-columns: 1fr 320px; gap: 12px; }
      .right { padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
      .big { font-size: 14px; font-weight: 900; }
      .foot { margin-top: 18px; font-size: 11px; color: var(--muted); display:flex; justify-content:space-between; }
      .actions { margin: 14px 0 0; display:flex; gap: 8px; }
      .btn { display:inline-block; border: 1px solid #111; border-radius: 10px; padding: 8px 10px; font-size: 12px; text-decoration:none; color:#111; }
      .btn.primary { background:#111; color:#fff; }
      @media print { .actions { display:none; } }
    </style>
  </head>
  <body>
    <div class="top">
      <div>
        <div class="brand">${escapeHtml(shop.name)}</div>
        <div class="muted">Generated from TechTubeBD ERP/POS</div>
      </div>
      <div class="inv">
        <div class="no">Invoice ${escapeHtml(sale.invoiceNo)}</div>
        <div class="muted">Date: ${escapeHtml(new Date(sale.soldAt).toLocaleString())}</div>
      </div>
    </div>

    <div class="actions">
      <a class="btn primary" href="#" onclick="window.print(); return false;">Print</a>
    </div>

    <div class="grid">
      <div class="box">
        <div class="muted" style="font-weight:700; margin-bottom:6px;">Bill To</div>
        <div class="row"><div class="k">Name</div><div class="v">${escapeHtml(customer?.name ?? 'Walk-in')}</div></div>
        <div class="row"><div class="k">Phone</div><div class="v">${escapeHtml(customer?.phone ?? '—')}</div></div>
      </div>
      <div class="box">
        <div class="muted" style="font-weight:700; margin-bottom:6px;">Payment</div>
        ${paymentsHtml}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="c1">#</th>
          <th>Item</th>
          <th class="c3">Qty</th>
          <th class="c4">Unit</th>
          <th class="c5">Disc</th>
          <th class="c6">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>

    <div class="totals">
      <div class="box">
        <div class="muted"><b>Notes</b></div>
        <div class="muted">Thank you for your purchase.</div>
      </div>
      <div class="right">
        <div class="row"><div class="k">Subtotal</div><div class="v">৳ ${escapeHtml(formatBDT(sale.subtotal))}</div></div>
        <div class="row"><div class="k">Discount</div><div class="v">৳ ${escapeHtml(formatBDT(sale.discountTotal))}</div></div>
        <div class="row"><div class="k">Total</div><div class="v big">৳ ${escapeHtml(formatBDT(sale.total))}</div></div>
        <div class="row"><div class="k">Paid</div><div class="v">৳ ${escapeHtml(formatBDT(sale.paidTotal))}</div></div>
        <div class="row"><div class="k">Balance due</div><div class="v">৳ ${escapeHtml(formatBDT(sale.dueAmount))}</div></div>
        ${
          sale.promisePayDate && Number(sale.dueAmount) > 0
            ? `<div class="row"><div class="k">Promised payment date</div><div class="v">${escapeHtml(String(sale.promisePayDate))}</div></div>`
            : ''
        }
      </div>
    </div>

    <div class="foot">
      <div>Shareable link: ${escapeHtml(`/public/invoices/${saleId}`)}</div>
      <div>Invoice ID is hidden (internal)</div>
    </div>
  </body>
</html>`;

  await writeFile(filePath, html, 'utf8');
  return { filePath, publicPath: `/public/invoices/${saleId}` };
}

export async function readInvoiceHtmlFile(saleId: string) {
  const filePath = join(STORAGE_DIR, `${saleId}.html`);
  const html = await readFile(filePath, 'utf8');
  return { filePath, html };
}

