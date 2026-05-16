import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as drawerService from '../../services/cash-drawer.service.js';

export async function registerCashDrawerRoutes(app: FastifyInstance) {
  app.post(
    '/cash-drawer/open',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z.object({ openingFloat: z.string().default('0') }).parse(request.body);
        const row = await drawerService.openSession(
          request.authUser.shopId,
          request.authUser.userId,
          body.openingFloat,
        );
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/cash-drawer/:id/close',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            expectedCash: z.string(),
            countedCash: z.string(),
          })
          .parse(request.body);
        const row = await drawerService.closeSession(
          request.authUser.shopId,
          request.authUser.userId,
          id,
          body,
        );
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/cash-drawer/sessions',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z.object({ limit: z.coerce.number().default(30) }).parse(request.query);
      const items = await drawerService.listSessions(
        request.authUser.shopId,
        q.limit,
      );
      return reply.send({ items });
    },
  );
}
