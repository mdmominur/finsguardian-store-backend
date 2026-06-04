import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import {
  hasPermission,
  canViewSalesRecords,
  canViewSupplierPricing,
  canListSalesInvoices,
  canViewWebOrderInvoices,
} from '../../lib/permissions.js';
import * as mailService from '../../services/mail.service.js';
import * as saleService from '../../services/sale.service.js';

function escHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function registerSaleRoutes(app: FastifyInstance) {
  app.get(
    '/sales',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const q = z
        .object({
          limit: z.coerce.number().min(1).max(20).default(20),
          offset: z.coerce.number().min(0).default(0),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          search: z.string().optional(),
          status: z
            .enum(['COMPLETED', 'VOID', 'REFUNDED', 'PARTIALLY_REFUNDED'])
            .optional(),
          channel: z.enum(['POS', 'WEB', 'IMPORT']).optional(),
        })
        .parse(request.query);

      if (!canListSalesInvoices(request.authUser, { channel: q.channel })) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }

      const { items, total } = await saleService.listSales(request.authUser.shopId, {
        limit: q.limit,
        offset: q.offset,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        search: q.search,
        status: q.status,
        channel: q.channel,
      });
      return reply.send({ items, total });
    },
  );

  app.get(
    '/sales/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const detail = await saleService.getSaleDetail(request.authUser.shopId, id);
      if (!detail) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Sale' });

      const ch = detail.sale.channel ?? 'POS';
      const canOpen =
        canViewSalesRecords(request.authUser) ||
        (ch === 'WEB' && canViewWebOrderInvoices(request.authUser));
      if (!canOpen) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }

      const lines = !canViewSupplierPricing(request.authUser)
        ? detail.lines.map((l) => {
            const { cogsUnitCost: _c, ...rest } = l;
            return rest;
          })
        : detail.lines;

      return reply.send({ ...detail, lines });
    },
  );

  app.patch(
    '/sales/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'customers.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            promisePayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          })
          .parse(request.body);
        const detail = await saleService.updateSalePromisePayDate(
          request.authUser.shopId,
          id,
          body.promisePayDate,
        );
        return reply.send(detail);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/sales/:id/send-invoice-email',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canViewSalesRecords(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!mailService.isMailConfigured()) {
          return reply.status(503).send({
            code: 'MAIL_NOT_CONFIGURED',
            message: 'Email is not configured on the server (MAIL_* env vars).',
          });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const detail = await saleService.getSaleDetail(request.authUser.shopId, id);
        if (!detail) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Sale' });

        const to = detail.customer?.email?.trim();
        if (!to) {
          return reply.status(400).send({
            code: 'NO_CUSTOMER_EMAIL',
            message: 'This sale has no customer email. Add an email on the customer profile.',
          });
        }

        const base = mailService.publicAppBaseUrl();
        if (!base) {
          return reply.status(503).send({
            code: 'PUBLIC_URL_MISSING',
            message: 'Set PUBLIC_APP_URL or CORS_ORIGIN to the storefront URL for invoice links.',
          });
        }

        const invoiceUrl = `${base}/sales/invoices/${id}/print`;
        const invNo = escHtml(detail.sale.invoiceNo);
        const shopNamePlain = (detail as { shopName?: string }).shopName?.trim() || 'Store';
        const shopName = escHtml(shopNamePlain);
        const shopAddrRaw = (detail as { shopAddress?: string | null }).shopAddress?.trim() || '';
        const shopAddr = shopAddrRaw ? escHtml(shopAddrRaw).replace(/\n/g, '<br/>') : '';
        const cust = detail.customer;
        const billName = cust?.name ? escHtml(cust.name) : 'Customer';
        const billPhone = cust?.phone ? escHtml(cust.phone) : '';
        const billAddrRaw = cust?.address?.trim() || '';
        const billAddr = billAddrRaw ? escHtml(billAddrRaw).replace(/\n/g, '<br/>') : '';

        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111;background:#f6f7f9">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;border:1px solid #e5e7eb">
    <p style="margin:0 0 16px;font-size:16px">Hello${cust?.name ? ` ${escHtml(cust.name)}` : ''},</p>
    <p style="margin:0 0 8px"><strong>${shopName}</strong> has issued your invoice <strong>${invNo}</strong>.</p>
    <p style="margin:0 0 20px;color:#4b5563;font-size:14px">Thank you for your purchase. You can view, download, or print your invoice using the button below.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <tr>
        <td style="vertical-align:top;width:50%;padding:14px 16px;background:#f9fafb;border-right:1px solid #e5e7eb">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;margin-bottom:8px">From</div>
          <div style="font-weight:600;color:#111">${shopName}</div>
          ${shopAddr ? `<div style="margin-top:8px;color:#374151;white-space:pre-wrap">${shopAddr}</div>` : '<div style="margin-top:6px;color:#9ca3af;font-size:12px">Address on file</div>'}
        </td>
        <td style="vertical-align:top;width:50%;padding:14px 16px;background:#fff">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;margin-bottom:8px">Bill to</div>
          <div style="font-weight:600;color:#111">${billName}</div>
          ${billPhone ? `<div style="margin-top:4px;color:#374151">${billPhone}</div>` : ''}
          ${billAddr ? `<div style="margin-top:8px;color:#374151;white-space:pre-wrap">${billAddr}</div>` : ''}
        </td>
      </tr>
    </table>

    <p style="margin:0 0 12px">
      <a href=${JSON.stringify(
        invoiceUrl,
      )} style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px">View invoice</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:12px">If the button does not work, copy this link into your browser:<br/><span style="word-break:break-all">${escHtml(
      invoiceUrl,
    )}</span></p>
  </div>
</body>
</html>`;

        const textLines = [
          `Hello${cust?.name ? ` ${cust.name}` : ''},`,
          ``,
          `${(detail as { shopName?: string }).shopName?.trim() || 'Store'} — Invoice ${detail.sale.invoiceNo}`,
          ``,
          `View invoice: ${invoiceUrl}`,
          shopAddrRaw ? `Shop address: ${shopAddrRaw}` : '',
          billAddrRaw ? `Your address: ${billAddrRaw}` : '',
        ].filter(Boolean);

        await mailService.sendMail({
          to,
          subject: `${shopNamePlain} — Invoice ${detail.sale.invoiceNo}`,
          text: textLines.join('\n'),
          html,
        });

        return reply.send({ ok: true, sentTo: to });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/sales/:id/refund',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'sales.refund')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            note: z.string().optional(),
            paymentMethodId: z.string().uuid().optional().nullable(),
            lines: z.array(
              z.object({
                saleLineId: z.string().uuid(),
                qty: z.string(),
                amount: z.string(),
                restock: z.boolean().optional(),
              }),
            ),
          })
          .parse(request.body);

        const refund = await saleService.createRefund(
          request.authUser.shopId,
          request.authUser.userId,
          id,
          body,
        );
        return reply.status(201).send(refund);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
