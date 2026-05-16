import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { assertShopModule } from '../../services/shop-features.service.js';

export async function registerReceiptRoutes(app: FastifyInstance) {
  app.get(
    '/receipts/:ledgerId/link',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'receipts.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'moneyReceiptsModuleEnabled');
        const { ledgerId } = z
          .object({ ledgerId: z.coerce.number().int().positive() })
          .parse(request.params);
        // Legacy endpoint kept for compatibility; frontend now uses token share links + print pages.
        return reply.send({ path: `/receipts/${ledgerId}` });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}

