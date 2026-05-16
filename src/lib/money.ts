/** PostgreSQL numeric comes as string from Drizzle — safe decimal helpers. */
export function toDecimalString(n: number | string): string {
  if (typeof n === 'string') return n;
  return n.toFixed(2);
}

export function addMoney(a: string, b: string): string {
  return (Number(a) + Number(b)).toFixed(2);
}

export function subMoney(a: string, b: string): string {
  return (Number(a) - Number(b)).toFixed(2);
}

export function mulMoney(qty: string, unit: string): string {
  return (Number(qty) * Number(unit)).toFixed(2);
}

export function roundMoney(n: number): string {
  return n.toFixed(2);
}
