import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { addSheet, newWorkbook, workbookResponse } from "@/lib/excel";
import { DISC_COLS, loadDiscrepancyRows } from "@/lib/export-data";
import { loadMetrics, loadResults, parseFilters, STATUS_FILTERS } from "@/lib/reports";
import type { Waterfall } from "@/lib/reconcile/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE: Record<string, string> = { matched: "Matched", suggested: "Suggested (not confirmed)", unmatched: "Not on the statement" };

export async function GET(request: Request) {
  const { profile } = await getSessionProfile();
  if (!profile || !profile.is_active) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const f = parseFilters(sp);
  const supabase = await createClient();

  const [results, metrics, discs] = await Promise.all([
    loadResults(supabase, f),
    loadMetrics(supabase, f),
    loadDiscrepancyRows(supabase, { supplier: f.supplier, period: f.period, status: "all", type: "", q: "" }),
  ]);

  const wb = newWorkbook();
  const statusLabel = STATUS_FILTERS.find(([k]) => k === f.status)?.[1] ?? "All";
  addSheet(wb, "Summary", [{ header: "Item", key: "k", width: 44 }, { header: "Value", key: "v", type: "text", width: 24 }], [
    { k: "Exported on", v: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" },
    { k: "Filter: supplier", v: f.supplier || "all" }, { k: "Filter: period", v: f.period || "all" },
    { k: "Filter: PO number", v: f.po || "" }, { k: "Filter: invoice number", v: f.invoice || "" }, { k: "Filter: status", v: statusLabel },
    { k: "Rows in results", v: String(results.length) },
    { k: "Supplier-reported outstanding", v: metrics.reportedOutstanding },
    { k: "Internally calculated outstanding", v: metrics.internalOutstanding ?? "run a reconciliation" },
    { k: "Matched invoices", v: String(metrics.invoicesMatched) }, { k: "Unmatched invoices", v: String(metrics.invoicesUnmatched) },
    { k: "Unmatched delivery notes", v: String(metrics.dnUnmatched) }, { k: "PO / invoice discrepancies", v: String(metrics.poInvoiceDiscrepancies) },
    { k: "Pending credit notes", v: String(metrics.creditNotesPending) }, { k: "Pending refunds", v: metrics.refundsPending },
    { k: "Completion", v: `${metrics.completionPct}%` },
  ]);

  addSheet(wb, "Reconciliation results", [
    { header: "Supplier", key: "supplierCode", width: 14 }, { header: "Document", key: "invoiceNumber", width: 22 }, { header: "Type", key: "docType", width: 12 },
    { header: "Date", key: "invoiceDate", type: "date" }, { header: "Our gross amount", key: "gross", type: "money" },
    { header: "Statement document", key: "soaDoc", width: 22 }, { header: "Statement amount", key: "soaAmount", type: "money" }, { header: "Difference (statement - ours)", key: "difference", type: "money", width: 18 },
    { header: "Result", key: "state", width: 24 }, { header: "How matched", key: "matchOrigin", width: 12 },
    { header: "PO on invoice", key: "poRefs", width: 24 }, { header: "Linked PO", key: "linkedPo", width: 22 }, { header: "Linked delivery note", key: "linkedDn", width: 22 },
    { header: "Open discrepancies", key: "openDiscrepancies", type: "int", width: 12 },
  ], results.map((r) => ({ ...r, docType: r.docType === "credit_note" ? "Credit note" : "Invoice", state: STATE[r.matchState] })));

  addSheet(wb, "Discrepancies", DISC_COLS, discs);

  if (f.period) {
    const { data: run } = await supabase.from("reconciliation_runs").select("run_number, summary").eq("period_id", f.period).order("run_number", { ascending: false }).limit(1).maybeSingle();
    const w = (run?.summary as { waterfall?: Waterfall } | undefined)?.waterfall;
    if (w) {
      const lines: Record<string, unknown>[] = [
        { k: `Reconciliation run #${run?.run_number}`, v: null },
        { k: "Supplier-reported closing balance", v: w.reportedClosing }, { k: "Our calculated closing balance", v: w.internalClosing }, { k: "Difference (supplier - ours)", v: w.difference },
        ...w.buckets.filter((b) => b.key !== "pending_suggestions").map((b) => ({ k: `${b.label} (${b.count})`, v: b.amount })),
        { k: "Not explained", v: w.unexplained }, ...w.notes.map((n) => ({ k: n, v: null })),
      ];
      addSheet(wb, "Balance comparison", [{ header: "Item", key: "k", width: 80 }, { header: "Amount", key: "v", type: "money" }], lines);
    }
  }
  return workbookResponse(wb, `reconciliation-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
