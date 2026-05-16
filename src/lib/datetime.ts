const DHAKA_TZ = 'Asia/Dhaka';

/** YYYY-MM-DD in Asia/Dhaka (for invoice prefixes and reporting keys). */
export function formatDhakaYmd(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function startOfDhakaDayUtc(dateYmd: string): Date {
  // Interpret YYYY-MM-DD as Dhaka midnight → approximate via fixed offset +6 (DST-free in BD)
  const [y, m, d] = dateYmd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1, 18, 0, 0));
}

/** Parse YYYY-MM-DD as a calendar day in Dhaka; returns false if invalid or not normalized. */
export function isValidDhakaYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T12:00:00+06:00`);
  if (Number.isNaN(t.getTime())) return false;
  return formatDhakaYmd(t) === s;
}

export function dhakaYmdPlusDays(ymd: string, deltaDays: number): string {
  const t = new Date(`${ymd}T12:00:00+06:00`);
  if (Number.isNaN(t.getTime())) throw new Error('Invalid YMD');
  const next = new Date(t.getTime() + deltaDays * 86400000);
  return formatDhakaYmd(next);
}

export function dhakaTodayPlusDays(deltaDays: number): string {
  return dhakaYmdPlusDays(formatDhakaYmd(new Date()), deltaDays);
}

/**
 * Promised payment date (Dhaka calendar): cannot be before today; no upper limit.
 * If omitted or invalid, defaults to today + 7 days (Dhaka).
 */
export function normalizePromisePayDate(raw: string | null | undefined): string {
  const todayYmd = formatDhakaYmd(new Date());
  const ymd = (raw ?? '').trim();
  const chosen = ymd && isValidDhakaYmd(ymd) ? ymd : dhakaTodayPlusDays(7);
  if (!isValidDhakaYmd(chosen)) {
    throw new Error('Invalid promised payment date');
  }
  if (chosen < todayYmd) {
    throw new Error('Promised payment date cannot be in the past');
  }
  return chosen;
}
