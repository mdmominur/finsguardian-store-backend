import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationOutbox,
  warrantyClaimEvents,
  warrantyClaims,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export async function createClaim(
  shopId: string,
  userId: string,
  input: {
    customerId: string;
    saleId?: string | null;
    productId?: string | null;
    deviceUnitId?: string | null;
    reportedIssue?: string | null;
    physicalCondition?: string | null;
    includedAccessories?: string | null;
    termsSnapshot?: string | null;
    notes?: string | null;
  },
) {
  const [row] = await db
    .insert(warrantyClaims)
    .values({
      shopId,
      customerId: input.customerId,
      saleId: input.saleId ?? null,
      productId: input.productId ?? null,
      deviceUnitId: input.deviceUnitId ?? null,
      reportedIssue: input.reportedIssue ?? null,
      physicalCondition: input.physicalCondition ?? null,
      includedAccessories: input.includedAccessories ?? null,
      status: 'RECEIVED',
      termsSnapshot: input.termsSnapshot ?? null,
      notes: input.notes ?? null,
    })
    .returning();

  if (!row) throw AppError.conflict('Could not create claim');

  await db.insert(warrantyClaimEvents).values({
    claimId: row.id,
    fromStatus: null,
    toStatus: 'RECEIVED',
    createdBy: userId,
  });

  return row;
}

export async function updateClaimStatus(
  shopId: string,
  userId: string,
  claimId: string,
  input: {
    status: string;
    note?: string | null;
    supplierId?: string | null;
    vendorRmaNumber?: string | null;
    replacementDeviceUnitId?: string | null;
  },
) {
  const [existing] = await db
    .select()
    .from(warrantyClaims)
    .where(and(eq(warrantyClaims.id, claimId), eq(warrantyClaims.shopId, shopId)))
    .limit(1);

  if (!existing) throw AppError.notFound('Claim not found');

  const from = existing.status;
  const to = input.status;

  const updates: Partial<typeof warrantyClaims.$inferInsert> = {
    status: to,
    updatedAt: new Date(),
    resolvedAt:
      to === 'RETURNED_TO_CUSTOMER' || to === 'CANCELLED'
        ? new Date()
        : existing.resolvedAt,
    turnaroundDays:
      to === 'RETURNED_TO_CUSTOMER' && existing.receivedAt
        ? Math.ceil(
            (Date.now() - new Date(existing.receivedAt).getTime()) /
              (24 * 3600 * 1000),
          )
        : existing.turnaroundDays,
  };

  if (input.supplierId !== undefined) updates.supplierId = input.supplierId;
  if (input.vendorRmaNumber !== undefined) updates.vendorRmaNumber = input.vendorRmaNumber;
  if (input.replacementDeviceUnitId !== undefined) updates.replacementDeviceUnitId = input.replacementDeviceUnitId;

  const [row] = await db
    .update(warrantyClaims)
    .set(updates)
    .where(eq(warrantyClaims.id, claimId))
    .returning();

  await db.insert(warrantyClaimEvents).values({
    claimId,
    fromStatus: from,
    toStatus: to,
    note: input.note ?? null,
    createdBy: userId,
  });

  if (to === 'READY_FOR_PICKUP') {
    await db.insert(notificationOutbox).values({
      shopId,
      channel: 'SMS',
      payload: {
        template: 'warranty_ready',
        claimId,
        customerId: existing.customerId,
      },
      status: 'PENDING',
    });
  }

  return row!;
}

import { customers, products, deviceUnits, sales } from '../db/schema/index.js';

export async function listClaims(shopId: string) {
  const rows = await db
    .select({
      claim: warrantyClaims,
      customerName: customers.name,
      customerPhone: customers.phone,
      productName: products.name,
      productSku: products.sku,
      imei1: deviceUnits.imei1,
      imei2: deviceUnits.imei2,
      serial: deviceUnits.serial,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
    })
    .from(warrantyClaims)
    .innerJoin(customers, eq(customers.id, warrantyClaims.customerId))
    .leftJoin(products, eq(products.id, warrantyClaims.productId))
    .leftJoin(deviceUnits, eq(deviceUnits.id, warrantyClaims.deviceUnitId))
    .leftJoin(sales, eq(sales.id, warrantyClaims.saleId))
    .where(eq(warrantyClaims.shopId, shopId))
    .orderBy(desc(warrantyClaims.receivedAt));

  return rows.map((r) => ({
    ...r.claim,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    productName: r.productName,
    productSku: r.productSku,
    imei1: r.imei1,
    imei2: r.imei2,
    serial: r.serial,
    invoiceNo: r.invoiceNo,
    soldAt: r.soldAt,
  }));
}
