import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import * as publicCustomerAuth from '../../services/public-customer-auth.service.js';

const requestOtpBody = z.object({
  channel: z.enum(['SMS', 'EMAIL']).default('SMS'),
  destination: z.string().min(3),
});

const verifyOtpBody = z.object({
  challengeId: z.string().uuid(),
  otp: z.string().min(4),
});

export async function registerPublicCustomerAuthRoutes(app: FastifyInstance) {
  app.post('/public/shops/:slug/auth/request-otp', async (request, reply) => {
    try {
      const slug = String((request.params as any).slug ?? '');
      const body = requestOtpBody.parse(request.body);
      const out = await publicCustomerAuth.requestCustomerOtp({
        shopSlug: slug,
        channel: body.channel,
        destination: body.destination,
      });
      return reply.send(out);
    } catch (e) {
      request.log.error(e, `Error in request-otp customer endpoint for shop ${String((request.params as any).slug ?? '')}`);
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid body',
          details: e.flatten(),
        });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.post('/public/shops/:slug/auth/verify-otp', async (request, reply) => {
    try {
      const slug = String((request.params as any).slug ?? '');
      const body = verifyOtpBody.parse(request.body);
      const out = await publicCustomerAuth.verifyCustomerOtp({
        shopSlug: slug,
        challengeId: body.challengeId,
        otp: body.otp,
      });
      return reply.send(out);
    } catch (e) {
      request.log.error(e, `Error in verify-otp customer endpoint for shop ${String((request.params as any).slug ?? '')}`);
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid body',
          details: e.flatten(),
        });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });
}

