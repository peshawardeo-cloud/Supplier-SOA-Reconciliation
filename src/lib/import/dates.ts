/** Parse a day-first date (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY). Returns ISO yyyy-mm-dd or null. */
export function parseDayFirstDate(raw: string): string | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return toIso(Number(m[3]), Number(m[2]), Number(m[1]));
}

/** Parse an ISO date or datetime (yyyy-mm-dd[ T]hh:mm:ss). Returns ISO date or null. */
export function parseIsoDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(raw.trim());
  if (!m) return null;
  return toIso(Number(m[1]), Number(m[2]), Number(m[3]));
}

function toIso(y: number, mo: number, d: number): string | null {
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null; // e.g. 31/02/2026
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
