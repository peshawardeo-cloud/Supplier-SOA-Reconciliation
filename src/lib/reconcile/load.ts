import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "@/lib/forms";
import type { EngineInput, LineIn } from "./engine";
import type { DocNumberRules } from "./normalize";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Read every row of a query (the API returns at most 1000 at a time). */
export async function fetchAll<T = Row>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const lines = (rows: unknown, kind: "po" | "dn" | "invoice"): LineIn[] =>
  ((rows ?? []) as Row[]).map((l) => ({
    itemCode: sn(l.item_code),
    qty: sn(kind === "dn" ? l.qty_delivered : l.qty),
    net: kind === "dn" ? null : sn(l.net_amount),
    unitPrice: kind === "po" ? sn(l.unit_price) : null,
  }));

/** Everything the engine needs for one period, read with the signed-in user's permissions. */
export async function buildEngineInput(supabase: SupabaseClient, supplierId: string, periodId: string): Promise<EngineInput> {
  const [{ data: period }, { data: st }] = await Promise.all([
    supabase.from("reconciliation_periods").select("*").eq("id", periodId).eq("supplier_id", supplierId).maybeSingle(),
    supabase.from("app_settings").select("*").eq("id", true).maybeSingle(),
  ]);
  if (!period) throw new UserError("Period not found.");
  if (!st) throw new UserError("Settings are missing.");

  const [soa, invoices, payments, pos, dns, payAlloc, crAlloc, matches, links] = await Promise.all([
    fetchAll((a, b) => supabase.from("soa_entries").select("id, entry_type, doc_number, doc_date, debit, credit, delivery_ref, po_ref").eq("period_id", periodId).is("deleted_at", null).order("source_row").range(a, b)),
    fetchAll((a, b) => supabase.from("invoices").select("id, doc_type, invoice_number, invoice_date, net_amount, vat_amount, gross_amount, vat_calculated, printed_gross, po_refs, dn_refs, invoice_lines(item_code, qty, net_amount)").eq("supplier_id", supplierId).is("deleted_at", null).order("invoice_date").order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("payments").select("id, payment_ref, payment_date, amount, bank_ref").eq("supplier_id", supplierId).is("deleted_at", null).order("payment_date").order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("po_headers").select("id, po_number, po_date, net_amount, po_lines(item_code, qty, unit_price, net_amount)").eq("supplier_id", supplierId).is("deleted_at", null).order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("dn_headers").select("id, dn_number, dn_date, po_refs, dn_lines(item_code, qty_delivered)").eq("supplier_id", supplierId).is("deleted_at", null).order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("payment_allocations").select("payment_id, invoice_id, amount, p:payments!inner(supplier_id)").eq("p.supplier_id", supplierId).is("voided_at", null).order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("credit_allocations").select("credit_note_id, invoice_id, amount, c:invoices!credit_allocations_credit_note_id_fkey!inner(supplier_id)").eq("c.supplier_id", supplierId).is("voided_at", null).order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("matches").select("soa_entry_id, invoice_id, payment_id, state").eq("period_id", periodId).order("id").range(a, b)),
    fetchAll((a, b) => supabase.from("doc_links").select("invoice_id, po_id, dn_id, state").eq("supplier_id", supplierId).order("id").range(a, b)),
  ]);

  return {
    period: { start: s(period.period_start), end: s(period.period_end), reportedOpening: sn(period.reported_opening_balance), reportedClosing: sn(period.reported_closing_balance) },
    settings: {
      vatRate: s(st.vat_rate),
      amountToleranceAbs: s(st.amount_tolerance_abs),
      amountTolerancePct: s(st.amount_tolerance_pct),
      qtyTolerance: s(st.qty_tolerance),
      dateWindowDays: Number(st.date_window_days),
      rules: (st.doc_number_rules ?? {}) as DocNumberRules,
    },
    soa: soa.map((e) => ({ id: s(e.id), type: s(e.entry_type) as EngineInput["soa"][number]["type"], docNumber: s(e.doc_number), docDate: s(e.doc_date), debit: s(e.debit), credit: s(e.credit), deliveryRef: sn(e.delivery_ref), poRef: sn(e.po_ref) })),
    invoices: invoices.map((i) => ({
      id: s(i.id), docType: s(i.doc_type) as "invoice" | "credit_note", number: s(i.invoice_number), date: s(i.invoice_date),
      net: s(i.net_amount), vat: s(i.vat_amount), gross: s(i.gross_amount), vatCalculated: Boolean(i.vat_calculated), printedGross: sn(i.printed_gross),
      poRefs: (i.po_refs as string[]) ?? [], dnRefs: (i.dn_refs as string[]) ?? [], lines: lines(i.invoice_lines, "invoice"),
    })),
    payments: payments.map((p) => ({ id: s(p.id), ref: s(p.payment_ref), date: s(p.payment_date), amount: s(p.amount), bankRef: sn(p.bank_ref) })),
    pos: pos.map((p) => ({ id: s(p.id), number: s(p.po_number), date: s(p.po_date), net: sn(p.net_amount), lines: lines(p.po_lines, "po") })),
    dns: dns.map((x) => ({ id: s(x.id), number: s(x.dn_number), date: s(x.dn_date), poRefs: (x.po_refs as string[]) ?? [], lines: lines(x.dn_lines, "dn") })),
    paymentAllocations: payAlloc.map((a) => ({ paymentId: s(a.payment_id), invoiceId: s(a.invoice_id), amount: s(a.amount) })),
    creditAllocations: crAlloc.map((a) => ({ creditNoteId: s(a.credit_note_id), invoiceId: s(a.invoice_id), amount: s(a.amount) })),
    existingMatches: matches.map((m) => ({ soaEntryId: s(m.soa_entry_id), invoiceId: sn(m.invoice_id), paymentId: sn(m.payment_id), state: s(m.state) as "pending" | "confirmed" | "rejected" | "superseded" })),
    existingLinks: links.map((l) => ({ invoiceId: s(l.invoice_id), poId: sn(l.po_id), dnId: sn(l.dn_id), state: s(l.state) as "pending" | "confirmed" | "rejected" | "superseded" })),
  };
}
