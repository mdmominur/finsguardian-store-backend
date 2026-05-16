import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { verifyCustomerAccessToken } from './customer-token.js';

export async function authenticateCustomer(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    await reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }
  const token = auth.slice('Bearer '.length).trim();
  const payload = verifyCustomerAccessToken(token, env.JWT_ACCESS_SECRET);
  if (!payload) {
    await reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
    return;
  }
  request.customerAuth = { shopId: payload.sid, customerId: payload.sub, accountId: payload.aid };
}

