import type { FastifyInstance } from 'fastify';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as batchIntegrity from '../../services/batch-integrity.service.js';

export async function registerBatchIntegrityRoutes(app: FastifyInstance) {
  app.get(
    '/batches/integrity',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'inventory.adjust')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const out = await batchIntegrity.listBatchIntegrityMismatches(request.authUser.shopId);
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/batches/integrity/fix',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'inventory.adjust')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const out = await batchIntegrity.fixBatchIntegrity(request.authUser.shopId);
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}

