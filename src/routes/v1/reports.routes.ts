import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission, canViewSupplierPricing } from '../../lib/permissions.js';
import * as reportService from '../../services/report.service.js';

export async function registerReportRoutes(app: FastifyInstance) {
  app.get(
    '/reports/dashboard',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'analytics.view')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const q = z
          .object({
            from: z.string().datetime(),
            to: z.string().datetime(),
          })
          .parse(request.query);

        const summary = await reportService.dashboardSummary(
          request.authUser.shopId,
          new Date(q.from),
          new Date(q.to),
        );
        return reply.send(summary);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/reports/pl',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'analytics.view')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const q = z
          .object({
            from: z.string().datetime(),
            to: z.string().datetime(),
          })
          .parse(request.query);

        const pl = await reportService.profitAndLoss(
          request.authUser.shopId,
          new Date(q.from),
          new Date(q.to),
        );
        if (!canViewSupplierPricing(request.authUser)) {
          const {
            cogs: _c,
            grossProfit: _g,
            netProfitEstimate: _n,
            expensesTotal: _e,
            expensesByCategory: _ec,
            ...rest
          } = pl;
          return reply.send(rest);
        }
        return reply.send(pl);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
