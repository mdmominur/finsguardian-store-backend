import { customAlphabet } from 'nanoid';

const suffix = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

/** Human-readable unique invoice number per transaction (avoids hot-row counter contention). */
export function generateInvoiceNo(dhakaYmd: string): string {
  return `INV-${dhakaYmd}-${suffix()}`;
}
