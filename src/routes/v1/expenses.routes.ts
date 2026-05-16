import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as expenseService from '../../services/expense.service.js';

export async function registerExpenseRoutes(app: FastifyInstance) {
  app.post(
    '/expenses/seed-categories',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      await expenseService.ensureDefaultExpenseCategories(request.authUser.shopId);
      const items = await expenseService.listCategories(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  app.get(
    '/expenses/categories',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const items = await expenseService.listCategories(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  app.post(
    '/expenses',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            categoryId: z.string().uuid(),
            paymentMethodId: z.string().uuid(),
            amount: z.string(),
            spentAt: z.string().optional(),
            note: z.string().nullable().optional(),
          })
          .parse(request.body);

        const row = await expenseService.createExpense(
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

  app.get(
    '/expenses',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z
        .object({
          limit: z.coerce.number().default(100),
          offset: z.coerce.number().default(0),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .parse(request.query);
      const items = await expenseService.listExpenses(request.authUser.shopId, {
        limit: q.limit,
        offset: q.offset,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      });
      return reply.send({ items });
    },
  );
}
