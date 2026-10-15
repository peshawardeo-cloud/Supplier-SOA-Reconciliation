import Decimal from "decimal.js";

// Exact decimal arithmetic for all money. Never use JavaScript floats for amounts.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Amount = Decimal;

export const d = (value: Decimal.Value | null | undefined): Decimal =>
  new Decimal(value ?? 0);

/** Round to 2 decimals, half-up (the configured rounding mode). */
export const round2 = (value: Decimal.Value): Decimal =>
  d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** VAT for a net amount. `rate` is a fraction, e.g. 0.15 for 15%. */
export const vatFor = (net: Decimal.Value, rate: Decimal.Value): Decimal =>
  round2(d(net).mul(rate));

export const grossFor = (net: Decimal.Value, rate: Decimal.Value): Decimal =>
  round2(d(net).plus(vatFor(net, rate)));

/** Allowed difference: the larger of the absolute and the percentage tolerance. */
export const toleranceFor = (
  gross: Decimal.Value,
  abs: Decimal.Value,
  pct: Decimal.Value,
): Decimal => Decimal.max(d(abs), d(gross).abs().mul(pct));

export const withinTolerance = (
  a: Decimal.Value,
  b: Decimal.Value,
  tolerance: Decimal.Value,
): boolean => d(a).minus(d(b)).abs().lte(d(tolerance));

/**
 * Parse an amount from a spreadsheet cell.
 * Handles: 1,234.50  (500.00)  500.00-  -500  SAR 1,200.00  "  12 "
 * Returns null when the value is blank or is not a number.
 * Assumes a comma is a thousands separator and a dot is the decimal point.
 */
export function parseAmount(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? new Decimal(raw) : null;

  let s = String(raw).trim();
  if (s === "") return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = s.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;

  const value = new Decimal(s);
  return negative ? value.neg() : value;
}
