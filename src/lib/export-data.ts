import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/reconcile/load";
import { ACTIVE_STATUSES, STATUS_LABEL, typeLabel, type DiscrepancyStatus } from "@/lib/discrepancy";
import { isUuid, safeSearch } from "@/lib/forms";
import type { Col } from "@/lib/excel";

export type DiscFilters = { supplier: string; period: string; status: string; type: string; q: string };

export function parseDiscFilters(sp: Record<string, string | undefined>): DiscFilters {
  return {
    supplier: isUuid(sp.supplier ?? "") ? sp.supplier! : "",
    period: isUuid(sp.period ?? "") ? sp.period! : "",
    status: sp.status ?? "active",
    type: sp.type ?? "",
    q: safeSearch(sp.q),
  };
}

export const DISC_COLS: Col[] = [
  { header: "Supplier", key: "supplier", width: 14 },
  { header: "Period start", key: "period_start", type: "date" },
  { header: "Period end", key: "period_end", type: "date" },
  { header: "Type", key: "type", width: 34 },
  { header: "Reference", key: "ref", width: 34 },
  { header: "Expected", key: "expected", type: "money" },
  { header: "Actual", key: "actual", type: "money" },
  { header: "Difference", key: "difference", type: "money" },
  { header: "Explanation", key: "explanation", width: 70 },
  { header: "Status", key: "status", width: 20 },
  { header: "Assigned to", key: "assignee", width: 24 },
  { header: "Notes", key: "notes", width: 40 },
  { header: "Resolution note", key: "resolution", width: 40 },
  { header: "Found on", key: "created", type: "date" },
];

type D = {
  type: string; status: DiscrepancyStatus; ref_text: string | null; expected_amount: string | null; actual_amount: string | null; difference: string | null;
  explanation: string; notes: string | null; resolution_note: string | null; created_at: string;
  supplier: { code: string } | null; period: { period_start: string; period_end: string } | null; assignee: { full_name: string | null; email: string | null } | null;
};

export async function loadDiscrepancyRows(supabase: SupabaseClient, f: DiscFilters) {
  const rows = await fetchAll<D>((a, b) => {
    let q = supabase
      .from("discrepancies")
      .select("type, status, ref_text, expected_amount, actual_amount, difference, explanation, notes, resolution_note, created_at, supplier:suppliers(code), period:reconciliation_periods(period_start, period_end), assignee:profiles!discrepancies_assigned_to_fkey(full_name, email)")
      .order("created_at", { ascending: false })
      .order("id")
      .range(a, b);
    if (f.supplier) q = q.eq("supplier_id", f.supplier);
    if (f.period) q = q.eq("period_id", f.period);
    if (f.type) q = q.eq("type", f.type);
    if (f.status === "active") q = q.in("status", ACTIVE_STATUSES);
    else if (f.status !== "all" && f.status) q = q.eq("status", f.status);
    if (f.q) q = q.or(`ref_text.ilike.%${f.q}%,explanation.ilike.%${f.q}%`);
    return q;
  });
  return rows.map((r) => ({
    supplier: r.supplier?.code,
    period_start: r.period?.period_start,
    period_end: r.period?.period_end,
    type: typeLabel(r.type),
    ref: r.ref_text,
    expected: r.expected_amount,
    actual: r.actual_amount,
    difference: r.expected_amount !== null || r.actual_amount !== null ? r.difference : null,
    explanation: r.explanation,
    status: STATUS_LABEL[r.status],
    assignee: r.assignee?.full_name ?? r.assignee?.email ?? "",
    notes: r.notes,
    resolution: r.resolution_note,
    created: r.created_at,
  }));
}
