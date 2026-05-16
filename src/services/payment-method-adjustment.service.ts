import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentMethodAdjustments, shopPaymentMethods } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export async function transferBetweenMethods(
  shopId: string,
  userId: string | null,
  input: {
    fromPaymentMethodId: string;
    toPaymentMethodId: string;
    amount: string;
    note?: string | null;
  },
) {
  if (input.fromPaymentMethodId === input.toPaymentMethodId) {
    throw AppError.badRequest('From and to payment methods must be different');
  }
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw AppError.badRequest('Amount must be a positive number');
  }

  const note = input.note?.trim() || null;

  return db.transaction(async (tx) => {
    const [fromPm] = await tx
      .select()
      .from(shopPaymentMethods)
      .where(and(eq(shopPaymentMethods.id, input.fromPaymentMethodId), eq(shopPaymentMethods.shopId, shopId)))
      .limit(1);
    if (!fromPm) throw AppError.notFound('From payment method not found');

    const [toPm] = await tx
      .select()
      .from(shopPaymentMethods)
      .where(and(eq(shopPaymentMethods.id, input.toPaymentMethodId), eq(shopPaymentMethods.shopId, shopId)))
      .limit(1);
    if (!toPm) throw AppError.notFound('To payment method not found');

    const transferLabel = 'Transfer';
    const outNote =
      note ??
      `${transferLabel} to ${toPm.name}`;
    const inNote =
      note ??
      `${transferLabel} from ${fromPm.name}`;

    const [outRow] = await tx
      .insert(paymentMethodAdjustments)
      .values({
        shopId,
        paymentMethodId: fromPm.id,
        amount: amt.toFixed(2),
        type: 'OUT',
        note: outNote,
        createdBy: userId,
      })
      .returning();

    const [inRow] = await tx
      .insert(paymentMethodAdjustments)
      .values({
        shopId,
        paymentMethodId: toPm.id,
        amount: amt.toFixed(2),
        type: 'IN',
        note: inNote,
        createdBy: userId,
      })
      .returning();

    if (!outRow || !inRow) throw AppError.conflict('Could not create transfer');

    return {
      ok: true,
      from: { adjustmentId: outRow.id, paymentMethodId: fromPm.id, paymentMethodName: fromPm.name },
      to: { adjustmentId: inRow.id, paymentMethodId: toPm.id, paymentMethodName: toPm.name },
      amount: amt.toFixed(2),
    };
  });
}

export async function createAdjustment(
  shopId: string,
  userId: string | null,
  input: {
    paymentMethodId: string;
    amount: string;
    type: 'IN' | 'OUT';
    note?: string | null;
  },
) {
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw AppError.badRequest('Amount must be a positive number');
  }
  if (input.type !== 'IN' && input.type !== 'OUT') {
    throw AppError.badRequest('Type must be IN or OUT');
  }

  const [pm] = await db
    .select()
    .from(shopPaymentMethods)
    .where(
      and(
        eq(shopPaymentMethods.id, input.paymentMethodId),
        eq(shopPaymentMethods.shopId, shopId),
      ),
    )
    .limit(1);
  if (!pm) throw AppError.notFound('Payment method not found');

  const [row] = await db
    .insert(paymentMethodAdjustments)
    .values({
      shopId,
      paymentMethodId: input.paymentMethodId,
      amount: amt.toFixed(2),
      type: input.type,
      note: input.note?.trim() || null,
      createdBy: userId,
    })
    .returning();

  if (!row) throw AppError.conflict('Could not create adjustment');
  return { ...row, paymentMethodName: pm.name };
}

export async function listAdjustments(
  shopId: string,
  opts: { paymentMethodId?: string; limit: number; offset: number },
) {
  const conds = [eq(paymentMethodAdjustments.shopId, shopId)];
  if (opts.paymentMethodId) {
    conds.push(eq(paymentMethodAdjustments.paymentMethodId, opts.paymentMethodId));
  }
  return db
    .select({
      id: paymentMethodAdjustments.id,
      paymentMethodId: paymentMethodAdjustments.paymentMethodId,
      paymentMethodName: shopPaymentMethods.name,
      amount: paymentMethodAdjustments.amount,
      type: paymentMethodAdjustments.type,
      note: paymentMethodAdjustments.note,
      createdAt: paymentMethodAdjustments.createdAt,
    })
    .from(paymentMethodAdjustments)
    .innerJoin(shopPaymentMethods, eq(shopPaymentMethods.id, paymentMethodAdjustments.paymentMethodId))
    .where(and(...conds))
    .orderBy(desc(paymentMethodAdjustments.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
}
