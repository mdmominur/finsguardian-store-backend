import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { customerLedgerEntries, customers, sales } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

type SharePayload =
  | { typ: 'invoice'; sid: string; id: string }
  | { typ: 'receipt'; sid: string; id: number };

export async function createInvoiceShareToken(
  app: FastifyInstance,
  shopId: string,
  saleId: string,
) {
  const [row] = await db
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.shopId, shopId)))
    .limit(1);
  if (!row) throw AppError.notFound('Sale not found');

  const payload: SharePayload = { typ: 'invoice', sid: shopId, id: saleId };
  const token = app.jwt.sign(payload as any, { expiresIn: '60d' });
  return token;
}

export async function createReceiptShareToken(
  app: FastifyInstance,
  shopId: string,
  ledgerId: number,
) {
  const [row] = await db
    .select({
      id: customerLedgerEntries.id,
      entryType: customerLedgerEntries.entryType,
    })
    .from(customerLedgerEntries)
    .innerJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
    .where(and(eq(customerLedgerEntries.id, ledgerId), eq(customers.shopId, shopId)))
    .limit(1);

  if (!row) throw AppError.notFound('Receipt not found');
  if (row.entryType !== 'PAYMENT') throw AppError.conflict('Not a payment receipt');

  const payload: SharePayload = { typ: 'receipt', sid: shopId, id: ledgerId };
  const token = app.jwt.sign(payload as any, { expiresIn: '60d' });
  return token;
}

export function verifyShareToken(app: FastifyInstance, token: string): SharePayload {
  let decoded: any;
  try {
    decoded = app.jwt.verify(token);
  } catch {
    throw AppError.unauthorized('Invalid or expired share link');
  }

  if (!decoded || typeof decoded !== 'object') throw AppError.unauthorized('Invalid share link');
  if (decoded.typ === 'invoice') {
    if (typeof decoded.sid !== 'string' || typeof decoded.id !== 'string') {
      throw AppError.unauthorized('Invalid share link');
    }
    return { typ: 'invoice', sid: decoded.sid, id: decoded.id };
  }
  if (decoded.typ === 'receipt') {
    if (typeof decoded.sid !== 'string' || typeof decoded.id !== 'number') {
      throw AppError.unauthorized('Invalid share link');
    }
    return { typ: 'receipt', sid: decoded.sid, id: decoded.id };
  }
  throw AppError.unauthorized('Invalid share link');
}

