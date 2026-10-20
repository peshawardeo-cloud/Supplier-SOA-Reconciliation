import type { SupabaseClient } from "@supabase/supabase-js";
import { d } from "@/lib/money";
import { fetchAll } from "@/lib/reconcile/load";
import { ACTIVE_STATUSES } from "@/lib/discrepancy";
import { isUuid, safeSearch } from "@/lib/forms";

export type ReportFilters = {
  supplier: string;
  period: string;
  status: "all" | "matched" | "suggested" | "unmatched" | "with_discrepancy";
  po: string;
  invoice: string;
};

export const STATUS_FILTERS: [ReportFilters["status"], string][] = [
  ["all", "All"],
  ["matched", "Matched"],
  ["suggested", "Suggested match to confirm"],
  ["unmatched", "Not on the statement"],
  ["with_discrepancy", "Has an open discrepancy"],
];

export function parseFilters(sp: Record<string, string | undefined>): ReportFilters {
  const status = STATUS_FILTERS.some(([k]) => k === sp.status) ? (sp.status as ReportFilters["status"]) : "all";
  return {
    supplier: isUuid(sp.supplier ?? "") ? sp.supplier! : "",
    period: isUuid(sp.period ?? "") ? sp.period! : "",
    status,
    po: safeSearch(sp.po),
    invoice: safeSearch(sp.invoice),
  };
}

export type ResultRow = {
  supplierCode: string;
  invoiceId: string;
  invoiceNumber: string;
  docType: string;
  invoiceDate: string;
  gross: string;
  poRefs: string;
  linkedPo: string;
  linkedDn: string;
  soaDoc: string;
  soaAmount: string | null;
  difference: string | null;
  matchState: "matched" | "suggested" | "unmatched";
  matchOrigin: string;
  openDiscrepancies: number;
};

type Inv = { id: string; invoice_number: string; doc_type: string; invoice_date: string; gross_amount: string; po_refs: string[]; supplier: { code: string } | null };
type Mt = { invoice_id: string; state: string; origin: string; soa: { doc_number: string; debit: string; credit: string; entry_type: string } | null };
type Lk = { invoice_id: string; state: string; po: { po_number: string } | null; dn: { dn_number: string } | null };

/** Reconciliation result per invoice / credit note, with the filters applied. Used by the dashboard and the Excel export. */
export async function loadResults(supabase: SupabaseClient, f: ReportFilters): Promise<ResultRow[]> {
  let periodEnd: string | null = null;
  let supplier = f.supplier;
  if (f.period) {
    const { data: p } = await supabase.from("reconciliation_periods").select("supplier_id, period_end").eq("id", f.period).maybeSingle();
    if (p) { periodEnd = p.period_end as string; supplier = p.supplier_id as string; }
  }

  const invoices = await fetchAll<Inv>((a, b) => {
    let q = supabase.from("invoices").select("id, invoice_number, doc_type, invoice_date, gross_amount, po_refs, supplier:suppliers(code)").is("deleted_at", null).order("invoice_date", { ascending: false }).order("id").range(a, b);
    if (supplier) q = q.eq("supplier_id", supplier);
    if (periodEnd) q = q.lte("invoice_date", periodEnd);
    if (f.invoice) q = q.ilike("invoice_number", `%${f.invoice}%`);
    return q;
  });
  if (invoices.length > 20000) throw new Error("Too many rows. Please filter by supplier or period.");

  const [matches, links, discs] = await Promise.all([
    fetchAll<Mt>((a, b) => {
      let q = supabase.from("matches").select("invoice_id, state, origin, soa:soa_entries(doc_number, debit, credit, entry_type)").not("invoice_id", "is", null).in("state", ["pending", "confirmed"]).order("id").range(a, b);
      if (f.period) q = q.eq("period_id", f.period);
      return q;
    }),
    fetchAll<Lk>((a, b) => {
      let q = supabase.from("doc_links").select("invoice_id, state, po:po_headers(po_number), dn:dn_headers(dn_number)").in("state", ["pending", "confirmed"]).order("id").range(a, b);
      if (supplier) q = q.eq("supplier_id", supplier);
      return q;
    }),
    fetchAll<{ invoice_id: string }>((a, b) => {
      let q = supabase.from("discrepancies").select("invoice_id").not("invoice_id", "is", null).in("status", ACTIVE_STATUSES).order("id").range(a, b);
      if (supplier) q = q.eq("supplier_id", supplier);
      if (f.period) q = q.eq("period_id", f.period);
      return q;
    }),
  ]);

  const matchBy = new Map<string, Mt>();
  for (const m of matches) {
    const cur = matchBy.get(m.invoice_id);
    if (!cur || (cur.state !== "confirmed" && m.state === "confirmed")) matchBy.set(m.invoice_id, m);
  }
  const poBy = new Map<string, Set<string>>(), dnBy = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.po) poBy.set(l.invoice_id, (poBy.get(l.invoice_id) ?? new Set()).add(l.po.po_number + (l.state === "pending" ? " (?)" : "")));
    if (l.dn) dnBy.set(l.invoice_id, (dnBy.get(l.invoice_id) ?? new Set()).add(l.dn.dn_number + (l.state === "pending" ? " (?)" : "")));
  }
  const discBy = new Map<string, number>();
  for (const x of discs) discBy.set(x.invoice_id, (discBy.get(x.invoice_id) ?? 0) + 1);

  const poNeedle = f.po.toLowerCase().replace(/[\s\-_/]/g, "");
  const out: ResultRow[] = [];
  for (const i of invoices) {
    const m = matchBy.get(i.id);
    const linkedPo = [...(poBy.get(i.id) ?? [])].join(", ");
    if (poNeedle) {
      const hay = [...(i.po_refs ?? []), linkedPo].join(" ").toLowerCase().replace(/[\s\-_/]/g, "");
      if (!hay.includes(poNeedle)) continue;
    }
    const state: ResultRow["matchState"] = m ? (m.state === "confirmed" ? "matched" : "suggested") : "unmatched";
    const soaAmt = m?.soa ? (m.soa.entry_type === "credit_note" || m.soa.entry_type === "payment" ? d(m.soa.credit).minus(m.soa.debit) : d(m.soa.debit).minus(m.soa.credit)) : null;
    const row: ResultRow = {
      supplierCode: i.supplier?.code ?? "",
      invoiceId: i.id,
      invoiceNumber: i.invoice_number,
      docType: i.doc_type,
      invoiceDate: i.invoice_date,
      gross: String(i.gross_amount),
      poRefs: (i.po_refs ?? []).join(", "),
      linkedPo,
      linkedDn: [...(dnBy.get(i.id) ?? [])].join(", "),
      soaDoc: m?.soa?.doc_number ?? "",
      soaAmount: soaAmt ? soaAmt.toFixed(2) : null,
      difference: soaAmt ? soaAmt.minus(i.gross_amount).toFixed(2) : null,
      matchState: state,
      matchOrigin: m?.origin ?? "",
      openDiscrepancies: discBy.get(i.id) ?? 0,
    };
    if (f.status === "matched" && state !== "matched") continue;
    if (f.status === "suggested" && state !== "suggested") continue;
    if (f.status === "unmatched" && state !== "unmatched") continue;
    if (f.status === "with_discrepancy" && row.openDiscrepancies === 0) continue;
    out.push(row);
  }
  return out;
}

export type Metrics = {
  suppliers: number;
  reportedOutstanding: string;
  internalOutstanding: string | null;
  periodsWithRun: number;
  invoicesTotal: number;
  invoicesMatched: number;
  invoicesUnmatched: number;
  dnUnmatched: number;
  poInvoiceDiscrepancies: number;
  creditNotesPending: number;
  creditNotesPendingAmount: string;
  refundsPending: string;
  refundsPendingCount: number;
  completionPct: number;
  periodsTotal: number;
  periodsDone: number;
  openDiscrepancies: number;
};

/** Headline figures. Respects the supplier / period filter. */
export async function loadMetrics(supabase: SupabaseClient, f: ReportFilters): Promise<Metrics> {
  let supplier = f.supplier;
  if (f.period) {
    const { data: p } = await supabase.from("reconciliation_periods").select("supplier_id").eq("id", f.period).maybeSingle();
    if (p) supplier = p.supplier_id as string;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bySupplier = (q: any) => (supplier ? q.eq("supplier_id", supplier) : q);

  const [{ count: suppliers }, periods, invoices, confirmed, dnLinks, dns, discs, refunds] = await Promise.all([
    supabase.from("suppliers").select("id", { count: "exact", head: true }).is("deleted_at", null),
    fetchAll<{ id: string; supplier_id: string; status: string; period_end: string; reported_closing_balance: string | null }>((a, b) => bySupplier(supabase.from("reconciliation_periods").select("id, supplier_id, status, period_end, reported_closing_balance")).order("period_end", { ascending: false }).order("id").range(a, b)),
    fetchAll<{ id: string; doc_type: string }>((a, b) => bySupplier(supabase.from("invoices").select("id, doc_type").is("deleted_at", null)).order("id").range(a, b)),
    fetchAll<{ invoice_id: string }>((a, b) => supabase.from("matches").select("invoice_id").eq("state", "confirmed").not("invoice_id", "is", null).order("id").range(a, b)),
    fetchAll<{ dn_id: string }>((a, b) => bySupplier(supabase.from("doc_links").select("dn_id").in("state", ["pending", "confirmed"]).not("dn_id", "is", null)).order("id").range(a, b)),
    fetchAll<{ id: string }>((a, b) => bySupplier(supabase.from("dn_headers").select("id").is("deleted_at", null)).order("id").range(a, b)),
    fetchAll<{ type: string; actual_amount: string | null; expected_amount: string | null }>((a, b) => bySupplier(supabase.from("discrepancies").select("type, actual_amount, expected_amount").in("status", ACTIVE_STATUSES)).order("id").range(a, b)),
    fetchAll<{ amount_claimed: string; amount_received: string }>((a, b) => bySupplier(supabase.from("refund_claims").select("amount_claimed, amount_received").not("status", "in", "(received,rejected)")).order("id").range(a, b)),
  ]);

  const scopedPeriods = f.period ? periods.filter((p) => p.id === f.period) : periods;
  // latest period per supplier
  const latest = new Map<string, (typeof periods)[number]>();
  for (const p of scopedPeriods) if (!latest.has(p.supplier_id)) latest.set(p.supplier_id, p);
  const reported = [...latest.values()].reduce((a, p) => a.plus(p.reported_closing_balance ?? 0), d(0));

  let internal = d(0);
  let withRun = 0;
  for (const p of latest.values()) {
    const { data: run } = await supabase.from("reconciliation_runs").select("summary").eq("period_id", p.id).order("run_number", { ascending: false }).limit(1).maybeSingle();
    const v = (run?.summary as { internal_closing?: string } | undefined)?.internal_closing;
    if (v !== undefined && v !== null) { internal = internal.plus(v); withRun++; }
  }

  const realInvoices = invoices.filter((i) => i.doc_type === "invoice");
  const confirmedSet = new Set(confirmed.map((m) => m.invoice_id));
  const matched = realInvoices.filter((i) => confirmedSet.has(i.id)).length;
  const linkedDn = new Set(dnLinks.map((l) => l.dn_id));
  const pendingCredits = discs.filter((x) => x.type === "credit_note_unapplied");
  const done = scopedPeriods.filter((p) => p.status === "completed" || p.status === "locked").length;

  return {
    suppliers: suppliers ?? 0,
    reportedOutstanding: reported.toFixed(2),
    internalOutstanding: withRun > 0 ? internal.toFixed(2) : null,
    periodsWithRun: withRun,
    invoicesTotal: realInvoices.length,
    invoicesMatched: matched,
    invoicesUnmatched: realInvoices.length - matched,
    dnUnmatched: dns.filter((x) => !linkedDn.has(x.id)).length,
    poInvoiceDiscrepancies: discs.filter((x) => x.type === "po_invoice_amount" || x.type === "po_invoice_qty").length,
    creditNotesPending: pendingCredits.length,
    creditNotesPendingAmount: pendingCredits.reduce((a, x) => a.plus(x.expected_amount ?? 0).minus(x.actual_amount ?? 0), d(0)).toFixed(2),
    refundsPending: refunds.reduce((a, r) => a.plus(r.amount_claimed).minus(r.amount_received), d(0)).toFixed(2),
    refundsPendingCount: refunds.length,
    completionPct: scopedPeriods.length ? Math.round((done / scopedPeriods.length) * 100) : 0,
    periodsTotal: scopedPeriods.length,
    periodsDone: done,
    openDiscrepancies: discs.length,
  };
}
