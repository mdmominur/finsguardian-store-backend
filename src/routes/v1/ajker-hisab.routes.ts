import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canManageShopSettings } from '../../lib/rbac.js';
import * as ajkerHisabService from '../../services/ajker-hisab.service.js';

export async function registerAjkerHisabRoutes(app: FastifyInstance) {
  const configSchema = z.object({
    enabled: z.boolean(),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    channels: z.object({
      SMS: z.boolean(),
      EMAIL: z.boolean(),
    }),
    smsRecipient: z.string().nullable(),
    emailRecipient: z.string().email().nullable(),
  });

  app.get(
    '/ajker-hisab',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const out = await ajkerHisabService.getAjkerHisabConfig(
          request.authUser.shopId,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/ajker-hisab',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }

        const body = configSchema.parse(request.body);

        // Client UI is best-effort validated too; enforce again server-side.
        if (body.channels.SMS && (!body.smsRecipient || body.smsRecipient.replace(/\D/g, '').length < 6)) {
          throw AppError.badRequest('SMS recipient phone is required/invalid');
        }
        if (body.channels.EMAIL && (!body.emailRecipient || body.emailRecipient.length < 5)) {
          throw AppError.badRequest('Email recipient is required/invalid');
        }

        if (!body.enabled) {
          body.smsRecipient = null;
          body.emailRecipient = null;
          body.channels = { SMS: false, EMAIL: false };
        }

        const out = await ajkerHisabService.updateAjkerHisabConfig(
          request.authUser.shopId,
          body,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}

