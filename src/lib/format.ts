import { d } from "@/lib/money";

/** 1234.5 -> "1,234.50". Display only: calculations always use decimal.js on the raw value. */
export function fmtMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  return d(v).toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 2026-05-04 -> 04/05/2026 (day-first, as in your documents). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, day] = iso.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const dt = new Date(iso);
  return (
    dt.toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" }) +
    " " +
    dt.toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit" })
  );
}
