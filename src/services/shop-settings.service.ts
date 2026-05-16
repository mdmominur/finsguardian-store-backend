import { and, count, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shopUsers, shops, users } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import {
  sanitizePermissionList,
  type PermissionKey,
} from '../lib/permissions.js';
import {
  isMultiStockLocationEnabledFromSettings,
  resolveShopModuleFlags,
  type ShopModuleFlags,
} from './shop-features.service.js';

function invoiceAddressFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const o = settings as Record<string, unknown>;
  const raw = o.invoiceAddress ?? o.shopAddress ?? o.address;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

export async function getShopSettings(shopId: string) {
  const [row] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!row) throw AppError.notFound('Shop not found');
  const smtp = readShopMailSmtp(row.settings);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    invoiceAddress: invoiceAddressFromSettings(row.settings),
    multiStockLocationEnabled: isMultiStockLocationEnabledFromSettings(row.settings),
    modules: resolveShopModuleFlags(row.settings),
    mail: smtp
      ? {
          smtp: {
            host: smtp.host ?? null,
            port: smtp.port ?? null,
            encryption: smtp.encryption ?? null,
            username: smtp.username ?? null,
            fromAddress: smtp.fromAddress ?? null,
            fromName: smtp.fromName ?? null,
            hasPassword: Boolean(smtp.password),
          },
        }
      : { smtp: null },
  };
}

type ShopMailSmtp = {
  host?: string;
  port?: number;
  encryption?: string;
  username?: string;
  password?: string;
  fromAddress?: string;
  fromName?: string;
};

function readSettingsObject(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

function readShopMailSmtp(settings: unknown): ShopMailSmtp | null {
  const s = readSettingsObject(settings);
  const mail = s.mail;
  if (!mail || typeof mail !== 'object' || Array.isArray(mail)) return null;
  const smtp = (mail as Record<string, unknown>).smtp;
  if (!smtp || typeof smtp !== 'object' || Array.isArray(smtp)) return null;
  const o = smtp as Record<string, unknown>;
  const host = typeof o.host === 'string' && o.host.trim() ? o.host.trim() : undefined;
  const encryption =
    typeof o.encryption === 'string' && o.encryption.trim() ? o.encryption.trim() : undefined;
  const username =
    typeof o.username === 'string' && o.username.trim() ? o.username.trim() : undefined;
  const password =
    typeof o.password === 'string' && o.password.trim() ? o.password.trim() : undefined;
  const fromAddress =
    typeof o.fromAddress === 'string' && o.fromAddress.trim() ? o.fromAddress.trim() : undefined;
  const fromName =
    typeof o.fromName === 'string' && o.fromName.trim() ? o.fromName.trim() : undefined;
  const portRaw = o.port;
  const portNum =
    typeof portRaw === 'number'
      ? portRaw
      : typeof portRaw === 'string'
        ? Number(portRaw)
        : NaN;
  const port = Number.isFinite(portNum) ? Number(portNum) : undefined;
  return { host, port, encryption, username, password, fromAddress, fromName };
}

export async function updateShopSettings(
  shopId: string,
  input: {
    name?: string;
    slug?: string | null;
    invoiceAddress?: string | null;
    multiStockLocationEnabled?: boolean;
    mail?: {
      smtp?:
        | {
            host?: string | null;
            port?: number | null;
            encryption?: string | null;
            username?: string | null;
            password?: string | null;
            fromAddress?: string | null;
            fromName?: string | null;
          }
        | null;
    } | null;
  } & Partial<ShopModuleFlags>,
) {
  const [current] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!current) throw AppError.notFound('Shop not found');

  if (input.slug !== undefined && input.slug !== null && input.slug.trim() !== '') {
    const normalized = input.slug.trim().toLowerCase();
    const [taken] = await db
      .select({ id: shops.id })
      .from(shops)
      .where(and(eq(shops.slug, normalized), ne(shops.id, shopId)))
      .limit(1);
    if (taken) throw AppError.conflict('That slug is already used');
  }

  const nextSettings = { ...readSettingsObject(current.settings) };

  let settingsDirty = false;

  if (input.invoiceAddress !== undefined) {
    const v = input.invoiceAddress?.trim() ?? '';
    if (v) nextSettings.invoiceAddress = v;
    else delete nextSettings.invoiceAddress;
    settingsDirty = true;
  }

  if (input.multiStockLocationEnabled !== undefined) {
    if (input.multiStockLocationEnabled) {
      nextSettings.multiStockLocationEnabled = true;
    } else {
      delete nextSettings.multiStockLocationEnabled;
    }
    settingsDirty = true;
  }

  const moduleKeys: (keyof ShopModuleFlags)[] = [
    'deviceRegistryEnabled',
    'warrantyModuleEnabled',
    'bundlesModuleEnabled',
    'stockAdjustmentsEnabled',
    'moneyReceiptsModuleEnabled',
  ];
  for (const k of moduleKeys) {
    if (input[k] !== undefined) {
      nextSettings[k] = input[k]!;
      settingsDirty = true;
    }
  }

  if (input.mail !== undefined) {
    if (input.mail === null) {
      delete (nextSettings as any).mail;
      settingsDirty = true;
    } else if (input.mail.smtp !== undefined) {
      if (input.mail.smtp === null) {
        const mailObj = (nextSettings.mail &&
          typeof nextSettings.mail === 'object' &&
          !Array.isArray(nextSettings.mail)
          ? (nextSettings.mail as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        delete mailObj.smtp;
        if (Object.keys(mailObj).length === 0) delete (nextSettings as any).mail;
        else (nextSettings as any).mail = mailObj;
        settingsDirty = true;
      } else {
        const prevMail =
          nextSettings.mail && typeof nextSettings.mail === 'object' && !Array.isArray(nextSettings.mail)
            ? (nextSettings.mail as Record<string, unknown>)
            : {};
        const prevSmtp =
          prevMail.smtp && typeof prevMail.smtp === 'object' && !Array.isArray(prevMail.smtp)
            ? (prevMail.smtp as Record<string, unknown>)
            : {};

        const nextSmtp: Record<string, unknown> = { ...prevSmtp };
        const patch = input.mail.smtp;

        const setOrDelete = (key: string, v: unknown) => {
          if (v === undefined) return;
          if (v === null) delete nextSmtp[key];
          else if (typeof v === 'string') {
            const s = v.trim();
            if (s) nextSmtp[key] = s;
            else delete nextSmtp[key];
          } else if (typeof v === 'number') {
            nextSmtp[key] = v;
          } else {
            nextSmtp[key] = v;
          }
        };

        setOrDelete('host', patch.host);
        setOrDelete('port', patch.port);
        setOrDelete('encryption', patch.encryption);
        setOrDelete('username', patch.username);
        setOrDelete('password', patch.password);
        setOrDelete('fromAddress', patch.fromAddress);
        setOrDelete('fromName', patch.fromName);

        (nextSettings as any).mail = { ...prevMail, smtp: nextSmtp };
        settingsDirty = true;
      }
    }
  }

  const setRow: { name?: string; slug?: string | null; settings?: unknown } = {};
  if (input.name !== undefined) setRow.name = input.name.trim();
  if (input.slug !== undefined) {
    const s = input.slug?.trim();
    setRow.slug = s ? s.toLowerCase() : null;
  }
  if (settingsDirty) setRow.settings = nextSettings;

  if (Object.keys(setRow).length === 0) {
    return getShopSettings(shopId);
  }

  await db.update(shops).set(setRow).where(eq(shops.id, shopId));

  return getShopSettings(shopId);
}

export type ShopMemberRow = {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  isOwner: boolean;
  /** Empty when isOwner — UI should show “full access”. */
  permissions: PermissionKey[];
};

export async function listShopMembers(shopId: string): Promise<ShopMemberRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: shopUsers.role,
      permissions: shopUsers.permissions,
    })
    .from(shopUsers)
    .innerJoin(users, eq(users.id, shopUsers.userId))
    .where(eq(shopUsers.shopId, shopId))
    .orderBy(users.name);

  return rows.map((r) => {
    const isOwner = r.role === 'owner';
    return {
      userId: r.userId,
      name: r.name,
      email: r.email,
      phone: r.phone,
      isOwner,
      permissions: isOwner ? [] : sanitizePermissionList(r.permissions),
    };
  });
}

export async function updateShopMember(
  shopId: string,
  targetUserId: string,
  input: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    permissions?: unknown;
    shopRole?: 'owner' | 'member';
  },
) {
  const hasPatch =
    input.name !== undefined ||
    input.email !== undefined ||
    input.phone !== undefined ||
    input.permissions !== undefined ||
    input.shopRole !== undefined;
  if (!hasPatch) throw AppError.badRequest('Nothing to update');

  await db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ role: shopUsers.role })
      .from(shopUsers)
      .where(and(eq(shopUsers.shopId, shopId), eq(shopUsers.userId, targetUserId)))
      .limit(1);

    if (!membership) throw AppError.notFound('User is not in this shop');

    const [userRow] = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!userRow) throw AppError.notFound('User not found');

    if (
      input.permissions !== undefined &&
      membership.role === 'owner' &&
      input.shopRole !== 'member'
    ) {
      throw AppError.badRequest('Owner permissions cannot be changed; demote to member first');
    }

    if (input.name !== undefined || input.email !== undefined || input.phone !== undefined) {
      const nextName = input.name !== undefined ? input.name.trim() : userRow.name;
      const nextEmail =
        input.email !== undefined
          ? input.email === null || String(input.email).trim() === ''
            ? null
            : String(input.email).trim().toLowerCase()
          : userRow.email;
      const nextPhone =
        input.phone !== undefined
          ? input.phone === null || String(input.phone).trim() === ''
            ? null
            : String(input.phone).trim()
          : userRow.phone;

      if (!nextEmail && !nextPhone) {
        throw AppError.badRequest('Email or phone is required');
      }

      if (nextEmail) {
        const [taken] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, nextEmail))
          .limit(1);
        if (taken && taken.id !== targetUserId) {
          throw AppError.conflict('That email is already used by another account');
        }
      }

      await tx
        .update(users)
        .set({ name: nextName, email: nextEmail, phone: nextPhone })
        .where(eq(users.id, targetUserId));
    }

    let roleAfter = membership.role;

    if (input.shopRole === 'owner' && membership.role === 'member') {
      await tx
        .update(shopUsers)
        .set({ role: 'owner', permissions: [] })
        .where(and(eq(shopUsers.shopId, shopId), eq(shopUsers.userId, targetUserId)));
      roleAfter = 'owner';
    } else if (input.shopRole === 'member' && membership.role === 'owner') {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(shopUsers)
        .where(and(eq(shopUsers.shopId, shopId), eq(shopUsers.role, 'owner')));
      if (Number(n) < 2) {
        throw AppError.badRequest('Cannot demote the only shop owner');
      }
      const perms = sanitizePermissionList(input.permissions);
      await tx
        .update(shopUsers)
        .set({ role: 'member', permissions: perms })
        .where(and(eq(shopUsers.shopId, shopId), eq(shopUsers.userId, targetUserId)));
      roleAfter = 'member';
    }

    if (input.permissions !== undefined && roleAfter === 'member') {
      const perms = sanitizePermissionList(input.permissions);
      await tx
        .update(shopUsers)
        .set({ permissions: perms })
        .where(and(eq(shopUsers.shopId, shopId), eq(shopUsers.userId, targetUserId)));
    }
  });

  return listShopMembers(shopId);
}

async function findUserByEmail(email: string) {
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return u ?? null;
}

async function findUserByPhone(phone: string) {
  const trimmed = phone.trim();
  if (!trimmed) return null;
  const [u] = await db.select().from(users).where(eq(users.phone, trimmed)).limit(1);
  return u ?? null;
}

/**
 * Add a user to the shop: link an existing account (matched by email or phone), or create a new user.
 * New owners cannot be created via this endpoint.
 */
export async function addShopMember(
  shopId: string,
  input: {
    name: string;
    email?: string | null;
    phone?: string | null;
    password?: string | null;
    permissions?: unknown;
  },
) {
  const granted = sanitizePermissionList(input.permissions);

  const email = input.email?.trim() ? input.email.trim().toLowerCase() : null;
  const phone = input.phone?.trim() ? input.phone.trim() : null;
  if (!email && !phone) {
    throw AppError.badRequest('Email or phone required');
  }

  const byEmail = email ? await findUserByEmail(email) : null;
  const byPhone = phone ? await findUserByPhone(phone) : null;
  if (byEmail && byPhone && byEmail.id !== byPhone.id) {
    throw AppError.badRequest('Email and phone belong to different accounts');
  }

  const existing = byEmail ?? byPhone;

  if (existing) {
    const [already] = await db
      .select({ userId: shopUsers.userId })
      .from(shopUsers)
      .where(and(eq(shopUsers.shopId, shopId), eq(shopUsers.userId, existing.id)))
      .limit(1);
    if (already) {
      throw AppError.conflict('This user is already in your shop');
    }

    await db.insert(shopUsers).values({
      shopId,
      userId: existing.id,
      role: 'member',
      permissions: granted,
    });

    return listShopMembers(shopId);
  }

  const pwd = input.password?.trim();
  if (!pwd || pwd.length < 8) {
    throw AppError.badRequest('Password is required (min 8 characters) for new users');
  }

  const passwordHash = await hashPassword(pwd);
  const displayName = input.name.trim();

  try {
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          email,
          phone,
          passwordHash,
          name: displayName,
        })
        .returning();

      if (!created) throw new Error('User insert failed');

      await tx.insert(shopUsers).values({
        shopId,
        userId: created.id,
        role: 'member',
        permissions: granted,
      });
    });
  } catch (e: unknown) {
    const code =
      e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined;
    if (code === '23505') {
      throw AppError.conflict('An account with this email or phone already exists');
    }
    throw e;
  }

  return listShopMembers(shopId);
}
