/**
 * IMEI normalization and Luhn check (GSMA / IMEI: double 1st, 3rd, 5th… digit from the **right**
 * of the 14-digit body — not the same parity as card-style Luhn on the full 15-digit string).
 */
export function normalizeImei(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.slice(0, 15);
}

export function isValidImeiFormat(imei: string): boolean {
  if (!/^\d{14,15}$/.test(imei)) return false;
  const body = imei.length === 15 ? imei.slice(0, 14) : imei;
  const check = imei.length === 15 ? imei[14] : undefined;
  if (check === undefined) return true;
  const expected = luhnCheckDigit(body);
  return expected === check;
}

function luhnCheckDigit(body14: string): string {
  let sum = 0;
  for (let i = 0; i < body14.length; i++) {
    let n = Number(body14[body14.length - 1 - i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  const mod = sum % 10;
  return String((10 - mod) % 10);
}

/** Correct 15th digit (Luhn) for the first 14 digits. */
export function expectedImeiCheckDigit(body14: string): string | null {
  if (!/^\d{14}$/.test(body14)) return null;
  return luhnCheckDigit(body14);
}
