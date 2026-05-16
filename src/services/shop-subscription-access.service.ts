import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shops } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export type MerchantSubscriptionPayload = {
  trialEndsAt: string;
  paidThrough: string | null;
  subscriptionStatus: string;
  isAccessAllowed: boolean;
};

export function buildMerchantSubscriptionPayload(row: {
  trialEndsAt: Date;
  paidThrough: Date | null;
  subscriptionStatus: string;
}): MerchantSubscriptionPayload {
  const now = Date.now();
  if (row.subscriptionStatus === 'suspended') {
    return {
      trialEndsAt: row.trialEndsAt.toISOString(),
      paidThrough: row.paidThrough ? row.paidThrough.toISOString() : null,
      subscriptionStatus: row.subscriptionStatus,
      isAccessAllowed: false,
    };
  }
  const trialOk = row.trialEndsAt.getTime() > now;
  const paidOk = row.paidThrough != null && row.paidThrough.getTime() >= now;
  return {
    trialEndsAt: row.trialEndsAt.toISOString(),
    paidThrough: row.paidThrough ? row.paidThrough.toISOString() : null,
    subscriptionStatus: row.subscriptionStatus,
    isAccessAllowed: trialOk || paidOk,
  };
}

/** Block merchant writes when trial ended and paid period not covering now, or shop suspended. */
export async function assertMerchantShopWriteAllowed(shopId: string): Promise<void> {
  const [row] = await db
    .select({
      trialEndsAt: shops.trialEndsAt,
      paidThrough: shops.paidThrough,
      subscriptionStatus: shops.subscriptionStatus,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!row) throw AppError.notFound('Shop not found');

  if (row.subscriptionStatus === 'suspended') {
    throw AppError.shopSuspended();
  }

  const { isAccessAllowed } = buildMerchantSubscriptionPayload(row);
  if (!isAccessAllowed) {
    throw AppError.subscriptionLapsed();
  }
}
