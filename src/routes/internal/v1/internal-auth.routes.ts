import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../../lib/errors.js';
import * as internalDashboardAuth from '../../../services/internal-dashboard-auth.service.js';

const requestOtpBody = z.object({
  email: z.string().email(),
});

const verifyOtpBody = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(6),
});

export async function registerInternalAuthRoutes(app: FastifyInstance) {
  app.post(
    '/auth/request-otp',
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
      try {
        const body = requestOtpBody.parse(request.body);
        const out = await internalDashboardAuth.requestInternalDashboardOtp(body.email);
        return reply.send({
          registered: out.registered,
          otpExpiresAt: out.otpExpiresAt,
          emailSent: out.registered ? Boolean(out.emailSent) : false,
        });
      } catch (e) {
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
    },
  );

  app.post(
    '/auth/verify-otp',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
      try {
        const body = verifyOtpBody.parse(request.body);
        const out = await internalDashboardAuth.verifyInternalDashboardOtp(body.email, body.code);
        return reply.send({ accessToken: out.accessToken });
      } catch (e) {
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
    },
  );
}
