import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { AppError, sendAppError } from './lib/errors.js';
import jwtAuth from './plugins/jwt-auth.js';
import { registerInternalV1Routes } from './routes/internal/v1/register.js';
import { registerV1Routes } from './routes/v1/register.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  await app.register(helmet, {
    global: true,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(cors, {
    // Development: allow any requesting origin (LAN IP, alternate hostnames) with credentials.
    origin:
      env.NODE_ENV === 'development'
        ? true
        : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 400,
    timeWindow: '1 minute',
  });

  await app.register(jwtAuth);

  app.get('/health', async () => ({
    ok: true,
    service: 'store-api',
    time: new Date().toISOString(),
  }));

  await registerV1Routes(app);
  await registerInternalV1Routes(app);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return sendAppError(reply, err);
    }
    request.log.error(err);
    const status =
      err && typeof err === 'object' && 'statusCode' in err
        ? Number((err as { statusCode?: number }).statusCode)
        : 500;
    const message =
      err instanceof Error ? err.message : 'Internal error';
    return reply.status(Number.isFinite(status) ? status : 500).send({
      code: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Internal error' : message,
    });
  });

  return app;
}
