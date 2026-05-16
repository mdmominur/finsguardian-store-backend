import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  customerLedgerEntries,
  customers,
  salePayments,
  sales,
  shops,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { formatDhakaYmd } from '../lib/datetime.js';

const STORAGE_DIR = join(process.cwd(), 'storage', 'receipts');

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

function receiptNoFromId(id: number, createdAt: Date) {
  const ymd = formatDhakaYmd(createdAt).replaceAll('-', '');
  return `MR-${ymd}-${String(id).padStart(6, '0')}`;
}

export async function ensureReceiptHtml(shopId: string, ledgerId: number) {
  await mkdir(STORAGE_DIR, { recursive: true });
  const filePath = join(STORAGE_DIR, `${ledgerId}.html`);

  try {
    await readFile(filePath, 'utf8');
    return { filePath, publicPath: `/public/receipts/${ledgerId}` };
  } catch {
    // generate
  }

  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw AppError.notFound('Shop not found');

  const [le] = await db
    .select()
    .from(customerLedgerEntries)
    .innerJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
    .where(and(eq(customerLedgerEntries.id, ledgerId), eq(customers.shopId, shopId)))
    .limit(1);

  if (!le) throw AppError.notFound('Receipt not found');

  const entry = le.customer_ledger_entries;
  const customer = le.customers;

  if (entry.entryType !== 'PAYMENT') throw AppError.conflict('Ledger entry is not a payment');

  // Amount is stored negative for PAYMENT. Display as positive received.
  const received = Math.abs(Number(entry.amount));

  const mrNo = receiptNoFromId(entry.id, entry.createdAt);

  const allocations = await db
    .select({
      saleId: sales.id,
      invoiceNo: sales.invoiceNo,
      amount: salePayments.amount,
    })
    .from(salePayments)
    .innerJoin(sales, eq(sales.id, salePayments.saleId))
    .where(
      and(
        eq(sales.shopId, shopId),
        eq(sales.customerId, customer.id),
        eq(salePayments.providerReference, `MR-${entry.id}`),
      ),
    )
    .orderBy(sales.soldAt);

  const allocTotal = allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const unallocated = Math.max(0, received - allocTotal);

  const allocHtml =
    allocations.length === 0
      ? `<div class="muted">No invoice allocation (ledger-only payment).</div>`
      : `<table>
  <thead><tr><th>Invoice</th><th style="text-align:right;">Applied</th></tr></thead>
  <tbody>
    ${allocations
      .map(
        (a) =>
          `<tr><td>${escapeHtml(a.invoiceNo)}</td><td style="text-align:right;">৳ ${escapeHtml(formatBDT(a.amount))}</td></tr>`,
      )
      .join('\n')}
  </tbody>
</table>`;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(mrNo)}</title>
    <style>
      :root { --ink:#111; --muted:#666; --line:#e6e6e6; }
      @page { size: A4; margin: 14mm; }
      body { font-family: Arial, Helvetica, sans-serif; color: var(--ink); }
      .top { display:flex; justify-content:space-between; gap: 16px; align-items:flex-start; }
      .brand { font-size: 18px; font-weight: 800; }
      .muted { color: var(--muted); font-size: 12px; line-height: 1.4; }
      .box { border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
      .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
      .row { display:flex; justify-content:space-between; gap: 12px; font-size: 12px; padding: 3px 0; }
      .k { color: var(--muted); }
      .v { font-weight: 700; }
      .big { font-size: 16px; font-weight: 900; }
      table { width:100%; border-collapse: collapse; margin-top: 10px; }
      th, td { border: 1px solid var(--line); padding: 8px; font-size: 12px; text-align:left; }
      thead th { background:#f6f6f6; }
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
        <div class="muted">Money receipt</div>
      </div>
      <div style="text-align:right;">
        <div class="big">${escapeHtml(mrNo)}</div>
        <div class="muted">Date: ${escapeHtml(new Date(entry.createdAt).toLocaleString())}</div>
      </div>
    </div>

    <div class="actions">
      <a class="btn primary" href="#" onclick="window.print(); return false;">Print</a>
    </div>

    <div class="grid">
      <div class="box">
        <div class="muted" style="font-weight:700; margin-bottom:6px;">Received From</div>
        <div class="row"><div class="k">Name</div><div class="v">${escapeHtml(customer.name)}</div></div>
        <div class="row"><div class="k">Phone</div><div class="v">${escapeHtml(customer.phone)}</div></div>
      </div>
      <div class="box">
        <div class="muted" style="font-weight:700; margin-bottom:6px;">Payment</div>
        <div class="row"><div class="k">Amount received</div><div class="v">৳ ${escapeHtml(formatBDT(received))}</div></div>
        <div class="row"><div class="k">Applied to invoices</div><div class="v">৳ ${escapeHtml(formatBDT(allocTotal))}</div></div>
        <div class="row"><div class="k">Unallocated</div><div class="v">৳ ${escapeHtml(formatBDT(unallocated))}</div></div>
      </div>
    </div>

    <div class="box" style="margin-top: 12px;">
      <div class="muted" style="font-weight:700; margin-bottom:6px;">Invoice allocation</div>
      ${allocHtml}
    </div>

    <div class="box" style="margin-top: 12px;">
      <div class="muted" style="font-weight:700; margin-bottom:6px;">Note</div>
      <div class="muted">${escapeHtml(entry.note ?? 'Payment received')}</div>
    </div>

    <div class="muted" style="margin-top: 16px;">
      Shareable link: ${escapeHtml(`/public/receipts/${entry.id}`)}
    </div>
  </body>
</html>`;

  await writeFile(filePath, html, 'utf8');
  return { filePath, publicPath: `/public/receipts/${ledgerId}` };
}

export async function readReceiptHtmlFile(ledgerId: number) {
  const filePath = join(STORAGE_DIR, `${ledgerId}.html`);
  const html = await readFile(filePath, 'utf8');
  return { filePath, html };
}

