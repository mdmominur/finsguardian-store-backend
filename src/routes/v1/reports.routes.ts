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
    '/reports/dashboard/metrics',
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

        const metrics = await reportService.dashboardMetrics(
          request.authUser.shopId,
          new Date(q.from),
          new Date(q.to),
        );
        return reply.send(metrics);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/reports/dashboard/receivables',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'analytics.view')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const receivables = await reportService.dashboardReceivables(
          request.authUser.shopId,
        );
        return reply.send(receivables);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/reports/dashboard/inventory-alerts',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'analytics.view')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const alerts = await reportService.dashboardInventoryAlerts(
          request.authUser.shopId,
        );
        return reply.send({ items: alerts });
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
