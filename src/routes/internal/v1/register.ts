import type { FastifyInstance } from 'fastify';
import { registerInternalAuthRoutes } from './internal-auth.routes.js';
import { registerInternalShopRoutes } from './internal-shops.routes.js';

export async function registerInternalV1Routes(app: FastifyInstance) {
  await app.register(
    async (r) => {
      await registerInternalAuthRoutes(r);
    },
    { prefix: '/api/internal/v1' },
  );
  await app.register(
    async (r) => {
      await registerInternalShopRoutes(r);
    },
    { prefix: '/api/internal/v1' },
  );
}
