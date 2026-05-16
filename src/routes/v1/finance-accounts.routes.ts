import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as financeAccountService from '../../services/finance-account.service.js';

export async function registerFinanceAccountRoutes(app: FastifyInstance) {
  app.get(
    '/finance-accounts',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const items = await financeAccountService.listAccountsWithBalances(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  app.get(
    '/finance-accounts/movements',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z
        .object({
          accountId: z.string().uuid().optional(),
          limit: z.coerce.number().min(1).max(200).default(80),
          offset: z.coerce.number().min(0).default(0),
        })
        .parse(request.query);
      const items = await financeAccountService.listMovements(request.authUser.shopId, q);
      return reply.send({ items });
    },
  );

  app.post(
    '/finance-accounts',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            name: z.string().min(1),
            kind: z.enum(['CASH', 'BANK', 'MFS', 'OTHER']),
            provider: z.enum(['BKASH', 'NAGAD', 'ROCKET']).nullable().optional(),
          })
          .parse(request.body);
        const row = await financeAccountService.createFinanceAccount(request.authUser.shopId, {
          name: body.name,
          kind: body.kind,
          provider: body.provider ?? null,
        });
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/finance-accounts/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().min(1).optional(),
            isActive: z.boolean().optional(),
            sortOrder: z.number().int().optional(),
          })
          .parse(request.body);
        const row = await financeAccountService.updateFinanceAccount(request.authUser.shopId, id, body);
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/finance-accounts/transfer',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            fromAccountId: z.string().uuid(),
            toAccountId: z.string().uuid(),
            amount: z.string(),
            note: z.string().nullable().optional(),
          })
          .parse(request.body);
        const row = await financeAccountService.createTransfer(
          request.authUser.shopId,
          request.authUser.userId,
          body,
        );
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/finance-accounts/opening',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            accountId: z.string().uuid(),
            delta: z.string(),
            note: z.string().nullable().optional(),
          })
          .parse(request.body);
        const out = await financeAccountService.postOpeningBalance(
          request.authUser.shopId,
          request.authUser.userId,
          body,
        );
        return reply.status(201).send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
