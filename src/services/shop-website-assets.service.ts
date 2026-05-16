import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shopWebsiteAssets, shops } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

const STORAGE_DIR = join(process.cwd(), 'storage', 'shop-website-assets');

const ALLOWED_MIME: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
};

export type WebsiteAssetKind = 'logo' | 'slider' | 'product' | 'productdesc';

function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const s = dataUrl.trim();
  const m = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) throw AppError.badRequest('Invalid dataUrl (expected base64 data URL)');
  const mime = m[1]!;
  const b64 = m[2]!;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw AppError.badRequest('Empty upload');
  return { mime, bytes };
}

export async function uploadShopWebsiteAsset(input: {
  shopId: string;
  kind: WebsiteAssetKind;
  dataUrl: string;
}) {
  const [shop] = await db
    .select({ id: shops.id, slug: shops.slug })
    .from(shops)
    .where(eq(shops.id, input.shopId))
    .limit(1);
  if (!shop) throw AppError.notFound('Shop not found');
  if (!shop.slug) throw AppError.conflict('Set a shop slug before uploading website assets');

  const { mime, bytes } = parseDataUrl(input.dataUrl);
  if (!ALLOWED_MIME[mime]) throw AppError.badRequest('Only PNG/JPEG/WEBP supported');

  // 10MB cap (base64 is larger in transit; this cap is on decoded bytes)
  if (bytes.length > 10 * 1024 * 1024) {
    throw AppError.badRequest('Image too large (max 10MB)');
  }

  // Always store as optimized WEBP.
  const optimized = await toWebp(bytes);
  const key = `${input.kind}_${nanoid(16)}.webp`;
  const dir = join(STORAGE_DIR, input.shopId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, key), optimized);

  await db.insert(shopWebsiteAssets).values({
    shopId: input.shopId,
    kind: input.kind,
    key,
    mime: 'image/webp',
    bytes: optimized.length,
  });

  const url = `/api/v1/public/shops/${encodeURIComponent(shop.slug)}/assets/${encodeURIComponent(
    key,
  )}`;
  return { key, url, mime: 'image/webp', bytes: optimized.length };
}

async function toWebp(input: Buffer): Promise<Buffer> {
  try {
    // Lazy import keeps startup fast; requires `sharp` dependency.
    const { default: sharp } = await import('sharp');
    return await sharp(input).webp({ quality: 82 }).toBuffer();
  } catch {
    throw AppError.conflict('Image optimizer not available. Install backend dependency: sharp');
  }
}

export async function readShopWebsiteAssetBySlug(input: {
  shopSlug: string;
  key: string;
}): Promise<{ mime: string; bytes: Buffer }> {
  const normalized = input.shopSlug.trim().toLowerCase();
  const [shop] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.slug, normalized))
    .limit(1);
  if (!shop) throw AppError.notFound('Shop not found');

  // Very strict key allowlist (prevents path traversal)
  if (!/^(logo|slider|product|productdesc)_[A-Za-z0-9_-]{10,}\.(png|jpg|webp)$/.test(input.key)) {
    throw AppError.notFound('Asset not found');
  }

  const filePath = join(STORAGE_DIR, shop.id, input.key);
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw AppError.notFound('Asset not found');
  }

  const ext = input.key.split('.').pop() ?? '';
  const mime =
    ext === 'png'
      ? 'image/png'
      : ext === 'jpg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : 'application/octet-stream';
  return { mime, bytes };
}

export async function deleteShopWebsiteAssetFile(input: { shopId: string; key: string }) {
  if (!/^(logo|slider|product|productdesc)_[A-Za-z0-9_-]{10,}\.(png|jpg|webp)$/.test(input.key)) {
    return { ok: true as const };
  }
  const filePath = join(STORAGE_DIR, input.shopId, input.key);
  try {
    await unlink(filePath);
  } catch {
    // ignore missing/unlink failures (DB is source of truth)
  }
  return { ok: true as const };
}

export async function deleteShopWebsiteAsset(input: { shopId: string; key: string }) {
  if (!/^(logo|slider|product|productdesc)_[A-Za-z0-9_-]{10,}\.(png|jpg|webp)$/.test(input.key)) {
    return { ok: true as const };
  }
  await db
    .delete(shopWebsiteAssets)
    .where(and(eq(shopWebsiteAssets.shopId, input.shopId), eq(shopWebsiteAssets.key, input.key)));
  await deleteShopWebsiteAssetFile({ shopId: input.shopId, key: input.key });
  return { ok: true as const };
}

