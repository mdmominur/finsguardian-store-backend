import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticateInternal` after validating Bearer internal token. */
    internalAuth?: { userId: string };

    /** Set by `authenticateCustomer` after validating Bearer customer token. */
    customerAuth?: { shopId: string; customerId: string; accountId: string };
  }
}
