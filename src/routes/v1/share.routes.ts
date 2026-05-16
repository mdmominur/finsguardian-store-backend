import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canViewSalesRecords, hasPermission } from '../../lib/permissions.js';
import * as shareService from '../../services/share-link.service.js';
import * as saleService from '../../services/sale.service.js';
import * as customerService from '../../services/customer.service.js';

export async function registerShareRoutes(app: FastifyInstance) {
  // Mint share links (auth required)
  app.get(
    '/share/invoices/:saleId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canViewSalesRecords(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { saleId } = z.object({ saleId: z.string().uuid() }).parse(request.params);
        const token = await shareService.createInvoiceShareToken(
          app,
          request.authUser.shopId,
          saleId,
        );
        return reply.send({ token });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/share/receipts/:ledgerId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'receipts.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { ledgerId } = z
          .object({ ledgerId: z.coerce.number().int().positive() })
          .parse(request.params);
        const token = await shareService.createReceiptShareToken(
          app,
          request.authUser.shopId,
          ledgerId,
        );
        return reply.send({ token });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Public invoice by sale UUID (no auth) — same data as print view.
  app.get('/public/invoices/:saleId', async (request, reply) => {
    const { saleId } = z.object({ saleId: z.string().uuid() }).parse(request.params);
    const detail = await saleService.getSaleDetailPublic(saleId);
    if (!detail) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'Invoice not found' });
    }
    return reply.send(detail);
  });

  // Public receipt by ledger ID (no auth) — for print page
  app.get('/public/receipts/:ledgerId', async (request, reply) => {
    const { ledgerId } = z.object({ ledgerId: z.coerce.number().int().positive() }).parse(request.params);
    try {
      const detail = await customerService.getMoneyReceiptDetailPublic(ledgerId);
      return reply.send(detail);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  // Public data endpoints (no auth) — token scoped to one invoice/receipt only.
  app.get('/public/share/invoice/:token', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.params);
    try {
      const payload = shareService.verifyShareToken(app, token);
      if (payload.typ !== 'invoice') throw AppError.notFound('Not invoice');
      const detail = await saleService.getSaleDetail(payload.sid, payload.id);
      if (!detail) throw AppError.notFound('Sale not found');
      return reply.send(detail);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/public/share/receipt/:token', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.params);
    try {
      const payload = shareService.verifyShareToken(app, token);
      if (payload.typ !== 'receipt') throw AppError.notFound('Not receipt');
      const detail = await customerService.getMoneyReceiptDetail(payload.sid, payload.id);
      return reply.send(detail);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });
}

