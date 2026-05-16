import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shops } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { isMailConfigured } from './mail.service.js';

export type WebsiteSliderItem = {
  id: string;
  imageUrl: string;
  href: string;
  altText?: string | null;
  sortOrder: number;
  isActive: boolean;
};

export type WebsiteTheme = {
  primaryColor: string | null;
  accentColor: string | null;
};

export type WebsiteContact = {
  supportEmail: string | null;
  supportPhone: string | null;
  facebookUrl: string | null;
};

export type WebsiteCheckout = {
  allowGuestCheckout: boolean;
  otpLive: boolean;
  defaultPaymentMethodHints: string | null;
};

export type WebsiteSeoDefaults = {
  defaultMetaTitleSuffix: string | null;
  defaultOgImageUrl: string | null;
};

export type WebsiteHeader = {
  showCategoryMenu: boolean;
  /** Category UUIDs for primary nav when `showCategoryMenu` is true. */
  menuCategoryIds: string[];
};

export type WebsiteFooter = {
  about: string | null;
  address: string | null;
  /** e.g. { "facebook": "https://...", "instagram": "https://..." } */
  socialLinks: Record<string, string>;
};

export type ShopWebsiteSettings = {
  enabled: boolean;
  publishedAt: string | null;
  logoUrl: string | null;
  policies: {
    privacy: string | null;
    terms: string | null;
    shipping: string | null;
    returns: string | null;
  };
  theme: WebsiteTheme;
  contact: WebsiteContact;
  checkout: WebsiteCheckout;
  seoDefaults: WebsiteSeoDefaults;
  header: WebsiteHeader;
  footer: WebsiteFooter;
  homepage: {
    sliderEnabled: boolean;
    sliderItems: WebsiteSliderItem[];
  };
};

function readSettingsObject(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

function readString(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.trim()) out.push(x.trim());
  }
  return out;
}

/** Exported for public storefront services that already loaded `shops.settings`. */
export function readWebsiteSettings(settings: unknown): ShopWebsiteSettings {
  const s = readSettingsObject(settings);
  const enabled = s.customerWebsiteEnabled === true;

  const policiesRaw =
    s.websitePolicies && typeof s.websitePolicies === 'object' && !Array.isArray(s.websitePolicies)
      ? (s.websitePolicies as Record<string, unknown>)
      : {};

  const homepageRaw =
    s.websiteHomepage && typeof s.websiteHomepage === 'object' && !Array.isArray(s.websiteHomepage)
      ? (s.websiteHomepage as Record<string, unknown>)
      : {};

  const sliderItemsRaw = Array.isArray(homepageRaw.sliderItems) ? homepageRaw.sliderItems : [];

  const sliderItems: WebsiteSliderItem[] = sliderItemsRaw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const imageUrl = typeof o.imageUrl === 'string' ? o.imageUrl : '';
      const href = typeof o.href === 'string' ? o.href : '';
      const sortOrder =
        typeof o.sortOrder === 'number' && Number.isFinite(o.sortOrder) ? o.sortOrder : 0;
      const isActive = o.isActive !== false;
      const altText =
        typeof o.altText === 'string' ? (o.altText.trim() ? o.altText.trim() : null) : null;
      if (!id || !imageUrl || !href) return null;
      return { id, imageUrl, href, altText, sortOrder, isActive };
    })
    .filter(Boolean)
    .sort((a, b) => a!.sortOrder - b!.sortOrder) as WebsiteSliderItem[];

  const logoUrl = typeof s.websiteLogoUrl === 'string' && s.websiteLogoUrl.trim()
    ? s.websiteLogoUrl.trim()
    : null;

  const publishedAt =
    typeof s.customerWebsitePublishedAt === 'string' && s.customerWebsitePublishedAt.trim()
      ? s.customerWebsitePublishedAt.trim()
      : null;

  const themeRaw =
    s.websiteTheme && typeof s.websiteTheme === 'object' && !Array.isArray(s.websiteTheme)
      ? (s.websiteTheme as Record<string, unknown>)
      : {};
  const theme: WebsiteTheme = {
    primaryColor: readString(themeRaw, 'primaryColor'),
    accentColor: readString(themeRaw, 'accentColor'),
  };

  const contactRaw =
    s.websiteContact && typeof s.websiteContact === 'object' && !Array.isArray(s.websiteContact)
      ? (s.websiteContact as Record<string, unknown>)
      : {};
  const contact: WebsiteContact = {
    supportEmail: readString(contactRaw, 'supportEmail'),
    supportPhone: readString(contactRaw, 'supportPhone'),
    facebookUrl: readString(contactRaw, 'facebookUrl'),
  };

  const checkoutRaw =
    s.websiteCheckout && typeof s.websiteCheckout === 'object' && !Array.isArray(s.websiteCheckout)
      ? (s.websiteCheckout as Record<string, unknown>)
      : {};
  const checkout: WebsiteCheckout = {
    allowGuestCheckout: false,
    otpLive: isMailConfigured(settings),
    defaultPaymentMethodHints: readString(checkoutRaw, 'defaultPaymentMethodHints'),
  };

  const seoRaw =
    s.websiteSeoDefaults &&
    typeof s.websiteSeoDefaults === 'object' &&
    !Array.isArray(s.websiteSeoDefaults)
      ? (s.websiteSeoDefaults as Record<string, unknown>)
      : {};
  const seoDefaults: WebsiteSeoDefaults = {
    defaultMetaTitleSuffix: readString(seoRaw, 'defaultMetaTitleSuffix'),
    defaultOgImageUrl: readString(seoRaw, 'defaultOgImageUrl'),
  };

  const headerRaw =
    s.websiteHeader && typeof s.websiteHeader === 'object' && !Array.isArray(s.websiteHeader)
      ? (s.websiteHeader as Record<string, unknown>)
      : {};
  const header: WebsiteHeader = {
    showCategoryMenu: headerRaw.showCategoryMenu === true,
    menuCategoryIds: readStringArray(headerRaw.menuCategoryIds),
  };

  const footerRaw =
    s.websiteFooter && typeof s.websiteFooter === 'object' && !Array.isArray(s.websiteFooter)
      ? (s.websiteFooter as Record<string, unknown>)
      : {};
  const socialRaw =
    footerRaw.socialLinks && typeof footerRaw.socialLinks === 'object' && !Array.isArray(footerRaw.socialLinks)
      ? (footerRaw.socialLinks as Record<string, unknown>)
      : {};
  const socialLinks: Record<string, string> = {};
  for (const [k, v] of Object.entries(socialRaw)) {
    if (typeof v === 'string' && v.trim()) socialLinks[k] = v.trim();
  }
  const footer: WebsiteFooter = {
    about: readString(footerRaw, 'about'),
    address: readString(footerRaw, 'address'),
    socialLinks,
  };

  return {
    enabled,
    publishedAt,
    logoUrl,
    policies: {
      privacy: typeof policiesRaw.privacy === 'string' ? (policiesRaw.privacy as string) : null,
      terms: typeof policiesRaw.terms === 'string' ? (policiesRaw.terms as string) : null,
      shipping: typeof policiesRaw.shipping === 'string' ? (policiesRaw.shipping as string) : null,
      returns: typeof policiesRaw.returns === 'string' ? (policiesRaw.returns as string) : null,
    },
    theme,
    contact,
    checkout,
    seoDefaults,
    header,
    footer,
    homepage: {
      sliderEnabled: homepageRaw.sliderEnabled === true,
      sliderItems,
    },
  };
}

export async function getShopWebsiteSettings(shopId: string) {
  const [row] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!row) throw AppError.notFound('Shop not found');
  return {
    shopId: row.id,
    slug: row.slug,
    website: readWebsiteSettings(row.settings),
  };
}

export async function patchShopWebsiteSettings(
  shopId: string,
  patch: Partial<{
    enabled: boolean;
    /** ISO 8601; set when shop “goes live” for analytics/support. */
    publishedAt: string | null;
    logoUrl: string | null;
    policies: Partial<ShopWebsiteSettings['policies']>;
    theme: Partial<ShopWebsiteSettings['theme']>;
    contact: Partial<ShopWebsiteSettings['contact']>;
    checkout: Partial<ShopWebsiteSettings['checkout']>;
    seoDefaults: Partial<ShopWebsiteSettings['seoDefaults']>;
    header: Partial<ShopWebsiteSettings['header']>;
    footer: Partial<ShopWebsiteSettings['footer']>;
    homepage: Partial<ShopWebsiteSettings['homepage']>;
  }>,
) {
  const [row] = await db
    .select({ settings: shops.settings, slug: shops.slug })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!row) throw AppError.notFound('Shop not found');

  const next = { ...readSettingsObject(row.settings) };


  if (patch.publishedAt !== undefined) {
    const v = patch.publishedAt?.trim() ?? '';
    if (v) next.customerWebsitePublishedAt = v;
    else delete next.customerWebsitePublishedAt;
  }

  if (patch.logoUrl !== undefined) {
    const v = patch.logoUrl?.trim() ?? '';
    if (v) next.websiteLogoUrl = v;
    else delete next.websiteLogoUrl;
  }

  if (patch.policies !== undefined) {
    const p =
      next.websitePolicies && typeof next.websitePolicies === 'object' && !Array.isArray(next.websitePolicies)
        ? { ...(next.websitePolicies as Record<string, unknown>) }
        : {};
    for (const k of ['privacy', 'terms', 'shipping', 'returns'] as const) {
      const raw = patch.policies[k];
      if (raw === undefined) continue;
      const v = (raw ?? '').toString().trim();
      if (v) p[k] = v;
      else delete p[k];
    }
    if (Object.keys(p).length > 0) next.websitePolicies = p;
    else delete next.websitePolicies;
  }

  if (patch.theme !== undefined) {
    const t =
      next.websiteTheme && typeof next.websiteTheme === 'object' && !Array.isArray(next.websiteTheme)
        ? { ...(next.websiteTheme as Record<string, unknown>) }
        : {};
    for (const k of ['primaryColor', 'accentColor'] as const) {
      const raw = patch.theme[k];
      if (raw === undefined) continue;
      const v = (raw ?? '').toString().trim();
      if (v) t[k] = v;
      else delete t[k];
    }
    if (Object.keys(t).length > 0) next.websiteTheme = t;
    else delete next.websiteTheme;
  }

  if (patch.contact !== undefined) {
    const c =
      next.websiteContact && typeof next.websiteContact === 'object' && !Array.isArray(next.websiteContact)
        ? { ...(next.websiteContact as Record<string, unknown>) }
        : {};
    for (const k of ['supportEmail', 'supportPhone', 'facebookUrl'] as const) {
      const raw = patch.contact[k];
      if (raw === undefined) continue;
      const v = (raw ?? '').toString().trim();
      if (v) c[k] = v;
      else delete c[k];
    }
    if (Object.keys(c).length > 0) next.websiteContact = c;
    else delete next.websiteContact;
  }

  if (patch.checkout !== undefined) {
    const ch =
      next.websiteCheckout && typeof next.websiteCheckout === 'object' && !Array.isArray(next.websiteCheckout)
        ? { ...(next.websiteCheckout as Record<string, unknown>) }
        : {};
    delete ch.allowGuestCheckout;
    if (patch.checkout.defaultPaymentMethodHints !== undefined) {
      const v = (patch.checkout.defaultPaymentMethodHints ?? '').toString().trim();
      if (v) ch.defaultPaymentMethodHints = v;
      else delete ch.defaultPaymentMethodHints;
    }
    if (Object.keys(ch).length > 0) next.websiteCheckout = ch;
    else delete next.websiteCheckout;
  }

  if (patch.seoDefaults !== undefined) {
    const se =
      next.websiteSeoDefaults &&
      typeof next.websiteSeoDefaults === 'object' &&
      !Array.isArray(next.websiteSeoDefaults)
        ? { ...(next.websiteSeoDefaults as Record<string, unknown>) }
        : {};
    for (const k of ['defaultMetaTitleSuffix', 'defaultOgImageUrl'] as const) {
      const raw = patch.seoDefaults[k];
      if (raw === undefined) continue;
      const v = (raw ?? '').toString().trim();
      if (v) se[k] = v;
      else delete se[k];
    }
    if (Object.keys(se).length > 0) next.websiteSeoDefaults = se;
    else delete next.websiteSeoDefaults;
  }

  if (patch.header !== undefined) {
    const h =
      next.websiteHeader && typeof next.websiteHeader === 'object' && !Array.isArray(next.websiteHeader)
        ? { ...(next.websiteHeader as Record<string, unknown>) }
        : {};
    if (patch.header.showCategoryMenu !== undefined) {
      if (patch.header.showCategoryMenu) h.showCategoryMenu = true;
      else delete h.showCategoryMenu;
    }
    if (patch.header.menuCategoryIds !== undefined) {
      h.menuCategoryIds = patch.header.menuCategoryIds;
    }
    if (Object.keys(h).length > 0) next.websiteHeader = h;
    else delete next.websiteHeader;
  }

  if (patch.footer !== undefined) {
    const f =
      next.websiteFooter && typeof next.websiteFooter === 'object' && !Array.isArray(next.websiteFooter)
        ? { ...(next.websiteFooter as Record<string, unknown>) }
        : {};
    if (patch.footer.about !== undefined) {
      const v = (patch.footer.about ?? '').toString().trim();
      if (v) f.about = v;
      else delete f.about;
    }
    if (patch.footer.address !== undefined) {
      const v = (patch.footer.address ?? '').toString().trim();
      if (v) f.address = v;
      else delete f.address;
    }
    if (patch.footer.socialLinks !== undefined) {
      const sl: Record<string, string> = {};
      for (const [k, v] of Object.entries(patch.footer.socialLinks)) {
        if (typeof v === 'string' && v.trim()) sl[k] = v.trim();
      }
      if (Object.keys(sl).length > 0) f.socialLinks = sl;
      else delete f.socialLinks;
    }
    if (Object.keys(f).length > 0) next.websiteFooter = f;
    else delete next.websiteFooter;
  }

  if (patch.homepage !== undefined) {
    const h =
      next.websiteHomepage && typeof next.websiteHomepage === 'object' && !Array.isArray(next.websiteHomepage)
        ? { ...(next.websiteHomepage as Record<string, unknown>) }
        : {};
    if (patch.homepage.sliderEnabled !== undefined) {
      if (patch.homepage.sliderEnabled) h.sliderEnabled = true;
      else delete h.sliderEnabled;
    }
    if (patch.homepage.sliderItems !== undefined) {
      h.sliderItems = patch.homepage.sliderItems as unknown as object[];
    }
    if (Object.keys(h).length > 0) next.websiteHomepage = h;
    else delete next.websiteHomepage;
  }

  await db.update(shops).set({ settings: next }).where(eq(shops.id, shopId));
  return getShopWebsiteSettings(shopId);
}
