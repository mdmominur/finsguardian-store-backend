import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { customerAddresses, shops } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import * as shopWebsiteService from './shop-website.service.js';

async function shopBySlugOrThrow(shopSlug: string) {
  const slug = shopSlug.trim();
  const [row] = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
  if (!row) throw AppError.notFound('Shop not found');
  const w = shopWebsiteService.readWebsiteSettings(row.settings);
  if (!w.enabled) throw AppError.notFound('Not published');
  return row;
}

export async function listCustomerAddresses(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const rows = await db
    .select()
    .from(customerAddresses)
    .where(and(eq(customerAddresses.shopId, shop.id), eq(customerAddresses.customerId, input.customerId)))
    .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.createdAt));

  return {
    items: rows.map((r) => ({
      id: r.id,
      label: r.label ?? null,
      recipientName: r.recipientName ?? null,
      phone: r.phone ?? null,
      line1: r.line1,
      line2: r.line2 ?? null,
      city: r.city ?? null,
      postalCode: r.postalCode ?? null,
      isDefault: r.isDefault,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  };
}

export async function createCustomerAddress(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  address: {
    label?: string | null;
    recipientName?: string | null;
    phone?: string | null;
    line1: string;
    line2?: string | null;
    city?: string | null;
    postalCode?: string | null;
    isDefault?: boolean;
  };
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const isDefault = input.address.isDefault === true;
  if (isDefault) {
    await db
      .update(customerAddresses)
      .set({ isDefault: false })
      .where(and(eq(customerAddresses.shopId, shop.id), eq(customerAddresses.customerId, input.customerId)));
  }

  const [row] = await db
    .insert(customerAddresses)
    .values({
      shopId: shop.id,
      customerId: input.customerId,
      label: input.address.label?.trim() ? input.address.label.trim() : null,
      recipientName: input.address.recipientName?.trim() ? input.address.recipientName.trim() : null,
      phone: input.address.phone?.trim() ? input.address.phone.trim() : null,
      line1: input.address.line1.trim(),
      line2: input.address.line2?.trim() ? input.address.line2.trim() : null,
      city: input.address.city?.trim() ? input.address.city.trim() : null,
      postalCode: input.address.postalCode?.trim() ? input.address.postalCode.trim() : null,
      isDefault,
    })
    .returning();

  return row!;
}

export async function updateCustomerAddress(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  addressId: string;
  patch: {
    label?: string | null;
    recipientName?: string | null;
    phone?: string | null;
    line1?: string;
    line2?: string | null;
    city?: string | null;
    postalCode?: string | null;
    isDefault?: boolean;
  };
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const [existing] = await db
    .select()
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.id, input.addressId),
        eq(customerAddresses.shopId, shop.id),
        eq(customerAddresses.customerId, input.customerId),
      ),
    )
    .limit(1);
  if (!existing) throw AppError.notFound('Address not found');

  const set: Partial<typeof customerAddresses.$inferInsert> = {};
  if (input.patch.label !== undefined) set.label = input.patch.label?.trim() ? input.patch.label.trim() : null;
  if (input.patch.recipientName !== undefined)
    set.recipientName = input.patch.recipientName?.trim() ? input.patch.recipientName.trim() : null;
  if (input.patch.phone !== undefined) set.phone = input.patch.phone?.trim() ? input.patch.phone.trim() : null;
  if (input.patch.line1 !== undefined) {
    const v = input.patch.line1.trim();
    if (!v) throw AppError.badRequest('line1 is required');
    set.line1 = v;
  }
  if (input.patch.line2 !== undefined) set.line2 = input.patch.line2?.trim() ? input.patch.line2.trim() : null;
  if (input.patch.city !== undefined) set.city = input.patch.city?.trim() ? input.patch.city.trim() : null;
  if (input.patch.postalCode !== undefined)
    set.postalCode = input.patch.postalCode?.trim() ? input.patch.postalCode.trim() : null;
  if (input.patch.isDefault !== undefined) set.isDefault = input.patch.isDefault === true;

  if (set.isDefault === true && !existing.isDefault) {
    await db
      .update(customerAddresses)
      .set({ isDefault: false })
      .where(and(eq(customerAddresses.shopId, shop.id), eq(customerAddresses.customerId, input.customerId)));
  }

  const [row] = await db
    .update(customerAddresses)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(customerAddresses.id, existing.id))
    .returning();
  return row!;
}

export async function deleteCustomerAddress(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  addressId: string;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const [row] = await db
    .delete(customerAddresses)
    .where(
      and(
        eq(customerAddresses.id, input.addressId),
        eq(customerAddresses.shopId, shop.id),
        eq(customerAddresses.customerId, input.customerId),
      ),
    )
    .returning();
  if (!row) throw AppError.notFound('Address not found');
  return { ok: true };
}

