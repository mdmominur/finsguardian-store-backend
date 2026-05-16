import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canUseInventoryDashboard, hasPermission } from '../../lib/permissions.js';
import * as batchService from '../../services/batch.service.js';
import { getDefaultLocationId } from '../../services/stock-location.service.js';

export async function registerProductBatchRoutes(app: FastifyInstance) {
  // FEFO batch list for a product at a specific stock location (for POS picker).
  app.get(
    '/products/:id/batches',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'pos.use') && !canUseInventoryDashboard(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z
          .object({
            locationId: z.string().uuid().optional(),
            includeZero: z.coerce.boolean().optional(),
          })
          .parse(request.query);

        const locationId = q.locationId ?? (await getDefaultLocationId(request.authUser.shopId));
        const out = await batchService.listProductBatchesForLocation({
          shopId: request.authUser.shopId,
          productId: id,
          locationId,
          includeZero: q.includeZero === true,
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}

