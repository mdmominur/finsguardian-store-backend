import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cashDrawerSessions } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export async function openSession(shopId: string, userId: string, openingFloat: string) {
  const [open] = await db
    .select()
    .from(cashDrawerSessions)
    .where(
      and(
        eq(cashDrawerSessions.shopId, shopId),
        isNull(cashDrawerSessions.closedAt),
      ),
    )
    .limit(1);

  if (open) throw AppError.conflict('A drawer session is already open');

  const [row] = await db
    .insert(cashDrawerSessions)
    .values({
      shopId,
      openedBy: userId,
      openingFloat,
    })
    .returning();

  return row!;
}

export async function closeSession(
  shopId: string,
  userId: string,
  sessionId: string,
  input: { expectedCash: string; countedCash: string },
) {
  const [sess] = await db
    .select()
    .from(cashDrawerSessions)
    .where(
      and(
        eq(cashDrawerSessions.id, sessionId),
        eq(cashDrawerSessions.shopId, shopId),
      ),
    )
    .limit(1);

  if (!sess) throw AppError.notFound('Session not found');
  if (sess.closedAt) throw AppError.conflict('Session already closed');

  const expected = Number(input.expectedCash);
  const counted = Number(input.countedCash);
  const variance = (counted - expected).toFixed(2);

  const [row] = await db
    .update(cashDrawerSessions)
    .set({
      closedAt: new Date(),
      closedBy: userId,
      expectedCash: input.expectedCash,
      countedCash: input.countedCash,
      variance,
    })
    .where(eq(cashDrawerSessions.id, sessionId))
    .returning();

  return row!;
}

export async function listSessions(shopId: string, limit: number) {
  return db
    .select()
    .from(cashDrawerSessions)
    .where(eq(cashDrawerSessions.shopId, shopId))
    .orderBy(desc(cashDrawerSessions.openedAt))
    .limit(limit);
}
