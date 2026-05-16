export const ROLES = ['owner', 'member'] as const;
export type Role = (typeof ROLES)[number];

export function canManageShopSettings(role: Role): boolean {
  return role === 'owner';
}

/**
 * Normalize DB/JWT role strings (trim, case) and accept legacy values until DB migration 007 is applied everywhere.
 */
export function parseRole(r: string): Role | null {
  const t = String(r ?? '')
    .trim()
    .toLowerCase();
  if (t === 'owner') return 'owner';
  if (t === 'member') return 'member';
  // Legacy shop_users.role before 007_shop_user_permissions.sql
  if (t === 'manager' || t === 'salesman' || t === 'warehouse') {
    return 'member';
  }
  return null;
}
