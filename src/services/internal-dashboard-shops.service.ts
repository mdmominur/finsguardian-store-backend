import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  internalDashboardUsers,
  shopSubscriptionPayments,
  shopUsers,
  shops,
  users,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export type SubscriptionStatus = 'trialing' | 'active' | 'lapsed' | 'suspended';

/** Effective SaaS status (column may lag; this matches list/metrics rules). */
export function subscriptionEffectiveCase() {
  return sql`(CASE
    WHEN ${shops.subscriptionStatus} = 'suspended' THEN 'suspended'
    WHEN ${shops.paidThrough} IS NOT NULL AND ${shops.paidThrough} >= now() THEN 'active'
    WHEN now() < ${shops.trialEndsAt} THEN 'trialing'
    ELSE 'lapsed'
  END)`;
}

function ceilDaysRemaining(target: Date): number {
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

function isAccessAllowed(row: {
  trialEndsAt: Date;
  paidThrough: Date | null;
  effectiveStatus: SubscriptionStatus;
}): boolean {
  if (row.effectiveStatus === 'suspended') return false;
  const now = Date.now();
  if (row.trialEndsAt.getTime() > now) return true;
  if (row.paidThrough && row.paidThrough.getTime() >= now) return true;
  return false;
}

function mapListRow(r: {
  id: string;
  name: string;
  slug: string | null;
  trialEndsAt: Date;
  paidThrough: Date | null;
  effectiveStatus: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
}) {
  const trialEndsAt = r.trialEndsAt;
  const paidThrough = r.paidThrough;
  const st = r.effectiveStatus as SubscriptionStatus;
  const inTrial = trialEndsAt.getTime() > Date.now();
  const paidOk = paidThrough && paidThrough.getTime() >= Date.now();
  const trialDaysLeft = inTrial ? ceilDaysRemaining(trialEndsAt) : null;
  const paidDaysLeft = paidOk && paidThrough ? ceilDaysRemaining(paidThrough) : null;
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    trialEndsAt: trialEndsAt.toISOString(),
    paidThrough: paidThrough ? paidThrough.toISOString() : null,
    subscriptionStatus: st,
    trialDaysLeft,
    paidDaysLeft,
    isAccessAllowed: isAccessAllowed({ trialEndsAt, paidThrough, effectiveStatus: st }),
    ownerEmail: r.ownerEmail,
    ownerPhone: r.ownerPhone,
  };
}

export async function internalMetricsSummary(): Promise<{
  trialing: number;
  active: number;
  lapsed: number;
  suspended: number;
}> {
  const eff = subscriptionEffectiveCase();
  const [row] = await db
    .select({
      trialing: sql<number>`count(*) filter (where ${eff} = 'trialing')::int`,
      active: sql<number>`count(*) filter (where ${eff} = 'active')::int`,
      lapsed: sql<number>`count(*) filter (where ${eff} = 'lapsed')::int`,
      suspended: sql<number>`count(*) filter (where ${eff} = 'suspended')::int`,
    })
    .from(shops);

  return {
    trialing: Number(row?.trialing ?? 0),
    active: Number(row?.active ?? 0),
    lapsed: Number(row?.lapsed ?? 0),
    suspended: Number(row?.suspended ?? 0),
  };
}

export async function internalListShops(q: {
  limit: number;
  offset: number;
  status?: SubscriptionStatus;
  search?: string;
  sort?: 'paidThroughAsc' | 'createdDesc';
}) {
  const eff = subscriptionEffectiveCase();
  const filters = [];

  if (q.search?.trim()) {
    const pattern = `%${q.search.trim()}%`;
    filters.push(
      or(
        ilike(shops.name, pattern),
        ilike(shops.slug, pattern),
        ilike(users.email, pattern),
        ilike(users.phone, pattern),
      )!,
    );
  }
  if (q.status) {
    filters.push(sql`(${eff}) = ${q.status}`);
  }

  const where = filters.length ? and(...filters) : undefined;

  const base = db
    .select({
      id: shops.id,
      name: shops.name,
      slug: shops.slug,
      trialEndsAt: shops.trialEndsAt,
      paidThrough: shops.paidThrough,
      effectiveStatus: sql<string>`${eff}`.as('effective_status'),
      ownerEmail: users.email,
      ownerPhone: users.phone,
    })
    .from(shops)
    .innerJoin(shopUsers, and(eq(shopUsers.shopId, shops.id), eq(shopUsers.role, 'owner')))
    .innerJoin(users, eq(users.id, shopUsers.userId))
    .where(where);

  const orderBy =
    q.sort === 'createdDesc'
      ? [desc(shops.createdAt)]
      : [sql`${shops.paidThrough} ASC NULLS LAST`, asc(shops.name)];

  const rows = await base.orderBy(...orderBy).limit(q.limit).offset(q.offset);

  const [cnt] = await db
    .select({ n: count() })
    .from(shops)
    .innerJoin(shopUsers, and(eq(shopUsers.shopId, shops.id), eq(shopUsers.role, 'owner')))
    .innerJoin(users, eq(users.id, shopUsers.userId))
    .where(where);

  return {
    items: rows.map(mapListRow),
    total: Number(cnt?.n ?? 0),
  };
}

export async function internalGetShop(shopId: string) {
  try {
    return await internalGetShopTx(shopId);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (/relation .* does not exist|column .* does not exist/i.test(text)) {
      throw AppError.badRequest(
        'Database is missing internal/subscription tables or columns. Apply docs/sql/027_internal_dashboard_auth.sql and 028_shop_subscription.sql (in order), then restart the API.',
      );
    }
    throw e;
  }
}

async function internalGetShopTx(shopId: string) {
  const eff = subscriptionEffectiveCase();
  const [row] = await db
    .select({
      id: shops.id,
      name: shops.name,
      slug: shops.slug,
      settings: shops.settings,
      createdAt: shops.createdAt,
      trialEndsAt: shops.trialEndsAt,
      paidThrough: shops.paidThrough,
      effectiveStatus: sql<string>`${eff}`.as('effective_status'),
      ownerEmail: users.email,
      ownerPhone: users.phone,
    })
    .from(shops)
    .innerJoin(shopUsers, and(eq(shopUsers.shopId, shops.id), eq(shopUsers.role, 'owner')))
    .innerJoin(users, eq(users.id, shopUsers.userId))
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!row) throw AppError.notFound('Shop not found');

  const payments = await db
    .select({
      id: shopSubscriptionPayments.id,
      shopId: shopSubscriptionPayments.shopId,
      amount: shopSubscriptionPayments.amount,
      currency: shopSubscriptionPayments.currency,
      periodDays: shopSubscriptionPayments.periodDays,
      paidAt: shopSubscriptionPayments.paidAt,
      validFrom: shopSubscriptionPayments.validFrom,
      validThrough: shopSubscriptionPayments.validThrough,
      note: shopSubscriptionPayments.note,
      recordedByInternalUserId: shopSubscriptionPayments.recordedByInternalUserId,
      recordedByEmail: internalDashboardUsers.email,
    })
    .from(shopSubscriptionPayments)
    .leftJoin(
      internalDashboardUsers,
      eq(shopSubscriptionPayments.recordedByInternalUserId, internalDashboardUsers.id),
    )
    .where(eq(shopSubscriptionPayments.shopId, shopId))
    .orderBy(desc(shopSubscriptionPayments.createdAt))
    .limit(20);

  const trialEndsAt = row.trialEndsAt;
  const paidThrough = row.paidThrough;
  const st = row.effectiveStatus as SubscriptionStatus;
  const inTrial = trialEndsAt.getTime() > Date.now();
  const paidOk = paidThrough && paidThrough.getTime() >= Date.now();

  const shop = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
    trialEndsAt: trialEndsAt.toISOString(),
    paidThrough: paidThrough ? paidThrough.toISOString() : null,
    subscriptionStatus: st,
    trialDaysLeft: inTrial ? ceilDaysRemaining(trialEndsAt) : null,
    paidDaysLeft: paidOk && paidThrough ? ceilDaysRemaining(paidThrough) : null,
    isAccessAllowed: isAccessAllowed({ trialEndsAt, paidThrough, effectiveStatus: st }),
    ownerEmail: row.ownerEmail,
    ownerPhone: row.ownerPhone,
  };

  return {
    shop,
    payments: payments.map((p) => ({
      id: p.id,
      shopId: p.shopId,
      amount: String(p.amount),
      currency: p.currency,
      periodDays: p.periodDays,
      paidAt: p.paidAt.toISOString(),
      validFrom: p.validFrom.toISOString(),
      validThrough: p.validThrough.toISOString(),
      note: p.note,
      recordedByUserId: p.recordedByInternalUserId,
      recordedByEmail: p.recordedByEmail ?? null,
    })),
  };
}

function statusAfterPayment(trialEndsAt: Date, paidThrough: Date | null): SubscriptionStatus {
  const now = Date.now();
  if (paidThrough && paidThrough.getTime() >= now) return 'active';
  if (trialEndsAt.getTime() > now) return 'trialing';
  return 'lapsed';
}

export async function internalRecordSubscriptionPayment(
  shopId: string,
  internalUserId: string,
  input: { amount: string; periodDays: number; paidAt?: Date | null; note?: string | null },
) {
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw AppError.badRequest('Amount must be a positive number');
  }
  const periodDays = Math.floor(input.periodDays);
  if (periodDays < 1 || periodDays > 3660) {
    throw AppError.badRequest('periodDays must be between 1 and 3660');
  }

  const paidAt = input.paidAt && !Number.isNaN(input.paidAt.getTime()) ? input.paidAt : new Date();

  await db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId)).limit(1);
    if (!shop) throw AppError.notFound('Shop not found');

    const now = new Date();
    const currentPaid = shop.paidThrough;
    const anchorMs = Math.max(now.getTime(), currentPaid ? currentPaid.getTime() : 0);
    const validFrom = new Date(anchorMs);
    const validThrough = new Date(anchorMs + periodDays * 86_400_000);

    await tx.insert(shopSubscriptionPayments).values({
      shopId,
      amount: amt.toFixed(2),
      currency: 'BDT',
      periodDays,
      paidAt,
      validFrom,
      validThrough,
      note: input.note?.trim() ? input.note.trim() : null,
      recordedByInternalUserId: internalUserId,
    });

    const nextPaidThrough = validThrough;
    const nextStatus = statusAfterPayment(shop.trialEndsAt, nextPaidThrough);

    await tx
      .update(shops)
      .set({
        paidThrough: nextPaidThrough,
        subscriptionStatus: nextStatus,
      })
      .where(eq(shops.id, shopId));
  });

  return internalGetShop(shopId);
}

function resolveSubscriptionStatusAfterPatch(input: {
  previousColumnStatus: string;
  trialEndsAt: Date;
  nextPaidThrough: Date | null;
  suspended?: boolean;
  paidThroughTouched: boolean;
  trialEndsAtTouched: boolean;
}): SubscriptionStatus {
  if (input.suspended === true) return 'suspended';
  if (input.suspended === false) {
    return statusAfterPayment(input.trialEndsAt, input.nextPaidThrough);
  }
  if (input.previousColumnStatus === 'suspended') {
    return 'suspended';
  }
  if (input.paidThroughTouched || input.trialEndsAtTouched) {
    return statusAfterPayment(input.trialEndsAt, input.nextPaidThrough);
  }
  return input.previousColumnStatus as SubscriptionStatus;
}

/**
 * Manual shop updates (suspend / paid_through correction). Spec §5 PATCH /shops/:id.
 */
export async function internalUpdateShop(
  shopId: string,
  patch: { suspended?: boolean; paidThrough?: Date | null; trialEndsAt?: Date; customerWebsiteEnabled?: boolean },
) {
  if (
    patch.suspended === undefined &&
    patch.paidThrough === undefined &&
    patch.trialEndsAt === undefined &&
    patch.customerWebsiteEnabled === undefined
  ) {
    throw AppError.badRequest('Provide suspended, paidThrough, trialEndsAt, or customerWebsiteEnabled');
  }

  await db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId)).limit(1);
    if (!shop) throw AppError.notFound('Shop not found');

    const paidThroughTouched = patch.paidThrough !== undefined;
    const trialEndsAtTouched = patch.trialEndsAt !== undefined;

    let nextPaidThrough = shop.paidThrough;
    if (paidThroughTouched) {
      nextPaidThrough = patch.paidThrough ?? null;
    }

    let nextTrialEndsAt = shop.trialEndsAt;
    if (paidThroughTouched && nextPaidThrough != null) {
      /** Manual paid end: trial matches paid (one expiry knob). */
      nextTrialEndsAt = nextPaidThrough;
    } else if (trialEndsAtTouched && patch.trialEndsAt) {
      nextTrialEndsAt = patch.trialEndsAt;
    }

    const nextStatus = resolveSubscriptionStatusAfterPatch({
      previousColumnStatus: shop.subscriptionStatus,
      trialEndsAt: nextTrialEndsAt,
      nextPaidThrough,
      suspended: patch.suspended,
      paidThroughTouched,
      trialEndsAtTouched,
    });

    const rowUpdate: Partial<typeof shops.$inferInsert> = { subscriptionStatus: nextStatus };
    if (paidThroughTouched) {
      rowUpdate.paidThrough = nextPaidThrough;
    }
    if (paidThroughTouched && nextPaidThrough != null) {
      rowUpdate.trialEndsAt = nextPaidThrough;
    } else if (trialEndsAtTouched) {
      rowUpdate.trialEndsAt = nextTrialEndsAt;
    }

    if (patch.customerWebsiteEnabled !== undefined) {
      const nextSettings = { ...(shop.settings as Record<string, unknown>) };
      if (patch.customerWebsiteEnabled) {
        nextSettings.customerWebsiteEnabled = true;
      } else {
        delete nextSettings.customerWebsiteEnabled;
      }
      rowUpdate.settings = nextSettings;
    }

    await tx.update(shops).set(rowUpdate).where(eq(shops.id, shopId));
  });

  return internalGetShop(shopId);
}
