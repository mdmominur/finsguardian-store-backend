import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, type DbTransaction } from '../db/client.js';
import {
  refreshTokens,
  shopUsers,
  shops,
  stockLocations,
  users,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import { parseRole, type Role } from '../lib/rbac.js';
import { sanitizePermissionList } from '../lib/permissions.js';
import { env } from '../config/env.js';
import {
  isMultiStockLocationEnabledFromSettings,
  resolveShopModuleFlags,
} from './shop-features.service.js';
import { buildMerchantSubscriptionPayload } from './shop-subscription-access.service.js';
import { seedFinanceAccountsTx } from './finance-account.service.js';
import { ensureDefaultShopPaymentMethods } from './shop-payment-method.service.js';

function hashRefresh(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export type RegisterShopTxInput = {
  shopName: string;
  shopSlug?: string | null;
  ownerName: string;
  /** Lowercased email — must be non-empty. */
  email: string;
  passwordHash: string;
};

/**
 * Create shop, default location, owner user, payment methods, finance seeds.
 * Caller supplies a pre-hashed password (e.g. from verified email OTP flow).
 */
export async function registerShopTx(tx: DbTransaction, input: RegisterShopTxInput) {
  const email = input.email.trim().toLowerCase();
  if (!email) throw AppError.badRequest('Email is required');

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 30);

  const [shop] = await tx
    .insert(shops)
    .values({
      name: input.shopName,
      slug: input.shopSlug?.trim() ? input.shopSlug.trim() : null,
      trialEndsAt,
      paidThrough: null,
      subscriptionStatus: 'trialing',
    })
    .returning();

  if (!shop) throw new Error('Shop insert failed');

  const [loc] = await tx
    .insert(stockLocations)
    .values({
      shopId: shop.id,
      name: 'Main',
      isDefault: true,
    })
    .returning();

  if (!loc) throw new Error('Location insert failed');

  const [user] = await tx
    .insert(users)
    .values({
      email,
      phone: null,
      passwordHash: input.passwordHash,
      name: input.ownerName,
    })
    .returning();

  if (!user) throw new Error('User insert failed');

  await tx.insert(shopUsers).values({
    shopId: shop.id,
    userId: user.id,
    role: 'owner',
    permissions: [],
  });

  await ensureDefaultShopPaymentMethods(tx, shop.id);
  await seedFinanceAccountsTx(tx, shop.id);

  return { shop, user, defaultLocationId: loc.id };
}

async function listMemberships(userId: string) {
  return db
    .select({
      shopId: shopUsers.shopId,
      role: shopUsers.role,
      shopName: shops.name,
      permissions: shopUsers.permissions,
    })
    .from(shopUsers)
    .innerJoin(shops, eq(shops.id, shopUsers.shopId))
    .where(eq(shopUsers.userId, userId));
}

async function signAccessToken(
  app: FastifyInstance,
  userId: string,
  shopId: string,
  role: Role,
  rawPermissions: unknown,
) {
  const payload: { sub: string; sid: string; role: Role; perms?: string[] } = {
    sub: userId,
    sid: shopId,
    role,
  };
  if (role === 'member') {
    payload.perms = sanitizePermissionList(rawPermissions);
  }
  return app.jwt.sign(payload);
}

export async function login(
  app: FastifyInstance,
  input: {
    email?: string;
    phone?: string;
    password: string;
    shopId?: string;
    userAgent?: string;
    ip?: string;
  },
) {
  if (!input.email && !input.phone) {
    throw AppError.badRequest('Email or phone required');
  }

  const [user] = await db
    .select()
    .from(users)
    .where(
      input.email
        ? eq(users.email, input.email.toLowerCase())
        : eq(users.phone, input.phone!),
    )
    .limit(1);

  if (!user || !user.isActive) {
    throw AppError.unauthorized('Invalid credentials');
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) throw AppError.unauthorized('Invalid credentials');

  const memberships = await listMemberships(user.id);
  if (memberships.length === 0) {
    throw AppError.forbidden('No shop access');
  }

  let shopId = input.shopId ?? null;
  let role: Role | null = null;
  let membership: (typeof memberships)[number] | null = null;

  if (shopId) {
    const m = memberships.find((x) => x.shopId === shopId);
    if (!m) throw AppError.forbidden('Not a member of this shop');
    role = parseRole(m.role);
    if (!role) throw AppError.forbidden('Invalid role');
    membership = m;
  } else if (memberships.length === 1) {
    shopId = memberships[0]!.shopId;
    role = parseRole(memberships[0]!.role);
    if (!role) throw AppError.forbidden('Invalid role');
    membership = memberships[0]!;
  } else {
    throw AppError.badRequest('shopId required — user belongs to multiple shops', {
      shops: memberships.map((m) => ({
        shopId: m.shopId,
        name: m.shopName,
        role: m.role,
      })),
    });
  }

  const accessToken = await signAccessToken(
    app,
    user.id,
    shopId!,
    role!,
    membership!.permissions,
  );

  const rawRefresh = randomBytes(32).toString('hex');
  const tokenHash = hashRefresh(rawRefresh);
  const expiresAt = new Date(
    Date.now() + env.JWT_REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  );

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
    userAgent: input.userAgent ?? null,
    ipInet: input.ip ?? null,
  });

  const [shopRow] = await db
    .select({
      settings: shops.settings,
      trialEndsAt: shops.trialEndsAt,
      paidThrough: shops.paidThrough,
      subscriptionStatus: shops.subscriptionStatus,
    })
    .from(shops)
    .where(eq(shops.id, shopId!))
    .limit(1);

  return {
    accessToken,
    refreshToken: rawRefresh,
    expiresInSec: env.JWT_ACCESS_EXPIRES_MIN * 60,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
    },
    shopId,
    role: role!,
    permissions:
      role === 'owner' ? ([] as string[]) : sanitizePermissionList(membership!.permissions),
    memberships,
    multiStockLocationEnabled: isMultiStockLocationEnabledFromSettings(shopRow?.settings),
    shopModules: resolveShopModuleFlags(shopRow?.settings),
    subscription: shopRow
      ? buildMerchantSubscriptionPayload({
          trialEndsAt: shopRow.trialEndsAt,
          paidThrough: shopRow.paidThrough,
          subscriptionStatus: shopRow.subscriptionStatus,
        })
      : undefined,
  };
}

export async function refreshTokensFlow(
  app: FastifyInstance,
  rawRefresh: string,
  opts?: { shopId?: string; userAgent?: string; ip?: string },
) {
  const tokenHash = hashRefresh(rawRefresh);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .limit(1);

  if (!row || row.expiresAt < new Date()) {
    throw AppError.unauthorized('Invalid refresh token');
  }

  const memberships = await listMemberships(row.userId);
  if (memberships.length === 0) {
    throw AppError.forbidden('No shop access');
  }

  let primary = memberships[0]!;
  if (opts?.shopId) {
    const m = memberships.find((x) => x.shopId === opts.shopId);
    if (!m) throw AppError.forbidden('Not a member of this shop');
    primary = m;
  } else if (memberships.length > 1) {
    throw AppError.badRequest('shopId required for refresh when user has multiple shops', {
      shops: memberships.map((x) => ({ shopId: x.shopId, name: x.shopName })),
    });
  }

  const refreshRole = parseRole(primary.role);
  if (!refreshRole) throw AppError.forbidden('Invalid role');

  const accessToken = await signAccessToken(
    app,
    row.userId,
    primary.shopId,
    refreshRole,
    primary.permissions,
  );

  const newRaw = randomBytes(32).toString('hex');
  const newHash = hashRefresh(newRaw);
  const expiresAt = new Date(
    Date.now() + env.JWT_REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  );

  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(refreshTokens)
      .values({
        userId: row.userId,
        tokenHash: newHash,
        expiresAt,
        userAgent: opts?.userAgent ?? null,
        ipInet: opts?.ip ?? null,
      })
      .returning();

    await tx
      .update(refreshTokens)
      .set({
        revokedAt: new Date(),
        replacedById: inserted?.id ?? null,
      })
      .where(eq(refreshTokens.id, row.id));
  });

  return {
    accessToken,
    refreshToken: newRaw,
    expiresInSec: env.JWT_ACCESS_EXPIRES_MIN * 60,
    shopId: primary.shopId,
    role: refreshRole,
    permissions:
      refreshRole === 'owner' ? [] : sanitizePermissionList(primary.permissions),
  };
}

export async function logoutRefresh(rawRefresh: string) {
  const tokenHash = hashRefresh(rawRefresh);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
      ),
    );
}

export async function getMe(userId: string, shopId: string) {
  const [u] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!u) throw AppError.notFound('User not found');

  const [m] = await db
    .select({
      role: shopUsers.role,
      shopName: shops.name,
      permissions: shopUsers.permissions,
      shopSettings: shops.settings,
      trialEndsAt: shops.trialEndsAt,
      paidThrough: shops.paidThrough,
      subscriptionStatus: shops.subscriptionStatus,
    })
    .from(shopUsers)
    .innerJoin(shops, eq(shops.id, shopUsers.shopId))
    .where(
      and(eq(shopUsers.userId, userId), eq(shopUsers.shopId, shopId)),
    )
    .limit(1);

  if (!m) throw AppError.forbidden('Not a member of this shop');

  const role = m.role as Role;
  return {
    user: u,
    shopId,
    role,
    shopName: m.shopName,
    permissions: role === 'owner' ? [] : sanitizePermissionList(m.permissions),
    multiStockLocationEnabled: isMultiStockLocationEnabledFromSettings(m.shopSettings),
    shopModules: resolveShopModuleFlags(m.shopSettings),
    subscription: buildMerchantSubscriptionPayload({
      trialEndsAt: m.trialEndsAt,
      paidThrough: m.paidThrough,
      subscriptionStatus: m.subscriptionStatus,
    }),
  };
}
