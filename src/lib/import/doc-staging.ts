import type { SupabaseClient } from "@supabase/supabase-js";
import { d } from "@/lib/money";
import { normalizeDocNumber, type DocNumberRules } from "@/lib/reconcile/normalize";
import type { DocControl, DocKind, ParsedDocRow } from "./doc-types";
import type { StagingRecord } from "./staging";
import type { RowIssue } from "./types";

type Ctx = {
  rules: DocNumberRules;
  supplier: { vat_number: string | null; currency: string };
  /** keys of documents already stored, built with `docKey` */
  existing: Set<string>;
  control?: DocControl;
  /** printed-total tolerance (SAR) */
  tolerance?: string;
};

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** Identity of a document within a supplier. */
export function docKey(kind: DocKind, docType: string | null, norm: string, date?: string | null, amount?: string | null): string {
  if (kind === "invoice") return `${docType ?? "invoice"}|${norm}`;
  if (kind === "payment") return `${norm}|${date}|${amount}`;
  return norm;
}

function parseRaw(raw: string): Record<string, unknown> {
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return { text: raw };
}

const issue = (field: string, code: string, message: string, severity: RowIssue["severity"] = "error"): RowIssue => ({ field, code, message, severity });

/**
 * Pure step. Rules:
 * - a row with an error rejects the WHOLE document (a half-imported invoice would be worse than none)
 * - a document already stored is marked duplicate and skipped
 * - for PDF invoices the printed totals must equal the sum of the lines that were read
 */
export function buildDocStagingRows(kind: DocKind, rows: ParsedDocRow[], ctx: Ctx) {
  const tol = d(ctx.tolerance ?? "0.05");
  const prepared = rows.map((r) => {
    const norm = r.docNumber ? normalizeDocNumber(r.docNumber, ctx.rules) : "";
    const key = kind === "payment" ? docKey(kind, null, norm, r.docDate, r.gross) : docKey(kind, r.docType, norm);
    return { r, norm, key, issues: [...r.issues] as RowIssue[] };
  });

  // Supplier identity (tax invoices carry the seller's VAT number).
  if (kind === "invoice" && ctx.control?.sellerVat && ctx.supplier.vat_number) {
    if (digits(ctx.control.sellerVat) !== digits(ctx.supplier.vat_number)) {
      for (const p of prepared) {
        p.issues.push(issue("seller_vat", "seller_mismatch", `The seller's VAT number ${ctx.control.sellerVat} is not this supplier's (${ctx.supplier.vat_number}). Wrong supplier?`));
      }
    }
  }

  const groups = new Map<string, typeof prepared>();
  for (const p of prepared) {
    if (kind === "payment") continue;
    const list = groups.get(p.key) ?? [];
    list.push(p);
    groups.set(p.key, list);
  }

  const groupError = new Map<string, string>();
  for (const [key, list] of groups) {
    if (!list[0].norm) continue;
    const dates = new Set(list.map((p) => p.r.docDate).filter(Boolean));
    if (dates.size > 1) groupError.set(key, "Lines of the same document have different dates.");
    if (kind === "invoice") {
      const header = list.find((p) => p.r.header)?.r.header;
      if (header?.gross) {
        const sum = list.reduce((a, p) => a.plus(p.r.gross ?? 0), d(0));
        if (sum.minus(header.gross).abs().gt(tol)) {
          groupError.set(key, `The lines add up to ${sum.toFixed(2)} but the total printed on the document is ${header.gross}. A line may not have been read.`);
        }
      }
      if (header?.net) {
        const sumNet = list.reduce((a, p) => a.plus(p.r.net ?? 0), d(0));
        if (sumNet.minus(header.net).abs().gt(tol) && !groupError.has(key)) {
          groupError.set(key, `The line amounts excluding VAT add up to ${sumNet.toFixed(2)} but the document prints ${header.net}.`);
        }
      }
    }
    if (list.some((p) => p.issues.some((i) => i.severity === "error")) === false && groupError.has(key)) {
      for (const p of list) p.issues.push(issue("document", "document_check_failed", groupError.get(key)!));
    }
  }
  // An error on any line rejects its siblings too.
  for (const [, list] of groups) {
    const bad = list.some((p) => p.issues.some((i) => i.severity === "error"));
    if (bad) {
      for (const p of list) {
        if (!p.issues.some((i) => i.severity === "error")) {
          p.issues.push(issue("document", "document_rejected", "Another line of this document has an error, so the whole document is not imported."));
        }
      }
    }
  }

  const records: StagingRecord[] = [];
  const counts = { valid: 0, errors: 0, duplicates: 0 };
  const seenPayments = new Set<string>();

  for (const p of prepared) {
    const { r } = p;
    let status: StagingRecord["status"] = "valid";
    if (p.issues.some((i) => i.severity === "error")) status = "error";
    else if (ctx.existing.has(p.key)) {
      status = "duplicate";
      p.issues.push(issue("doc_number", "already_imported", "This document has already been imported.", "warning"));
    } else if (kind === "payment") {
      if (seenPayments.has(p.key)) {
        status = "duplicate";
        p.issues.push(issue("doc_number", "duplicate_in_file", "The same payment appears more than once in this file.", "warning"));
      }
      seenPayments.add(p.key);
    }
    if (r.currency && r.currency !== ctx.supplier.currency) {
      p.issues.push(issue("currency", "currency_mismatch", `Currency ${r.currency} differs from the supplier's currency ${ctx.supplier.currency}.`, "warning"));
    }
    if (status === "valid") counts.valid++;
    else if (status === "error") counts.errors++;
    else counts.duplicates++;

    const itemNorm = r.itemCode ? normalizeDocNumber(r.itemCode, { ignore_separators: true }) : null;
    records.push({
      row_number: r.rowNumber,
      raw: parseRaw(r.raw),
      mapped: {
        doc_key: p.key,
        doc_number: r.docNumber,
        doc_number_norm: p.norm,
        doc_date: r.docDate,
        doc_type: r.docType,
        due_date: r.dueDate,
        po_refs: r.poRefs,
        dn_refs: r.dnRefs,
        project_ref: r.projectRef,
        received_by: r.receivedBy,
        method: r.method,
        bank_ref: r.bankRef,
        bank_ref_norm: r.bankRef ? normalizeDocNumber(r.bankRef, ctx.rules) : null,
        currency: r.currency,
        item_code: r.itemCode,
        item_code_norm: itemNorm,
        description: r.description,
        uom: r.uom,
        qty: r.qty,
        unit_price: r.unitPrice,
        net: r.net,
        vat: r.vat,
        gross: r.gross,
        vat_calculated: r.vatCalculated,
        header: r.header,
      },
      status,
      issues: p.issues,
      duplicate_of: null,
    });
  }
  const documents = kind === "payment" ? counts.valid : new Set(records.filter((x) => x.status === "valid").map((x) => x.mapped.doc_key as string)).size;
  return { records, counts, documents };
}

const TABLES: Record<DocKind, { table: string; select: string }> = {
  po: { table: "po_headers", select: "po_number_norm" },
  dn: { table: "dn_headers", select: "dn_number_norm" },
  invoice: { table: "invoices", select: "doc_type, invoice_number_norm" },
  payment: { table: "payments", select: "payment_ref_norm, payment_date, amount" },
};

export async function loadExistingDocKeys(supabase: SupabaseClient, kind: DocKind, supplierId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const { table, select } = TABLES[kind];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).eq("supplier_id", supplierId).is("deleted_at", null).range(from, from + 999);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as Record<string, string>[]) {
      if (kind === "po") out.add(row.po_number_norm);
      else if (kind === "dn") out.add(row.dn_number_norm);
      else if (kind === "invoice") out.add(docKey(kind, row.doc_type, row.invoice_number_norm));
      else out.add(docKey(kind, null, row.payment_ref_norm, row.payment_date, Number(row.amount).toFixed(2)));
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function stageDocBatch(
  supabase: SupabaseClient,
  args: {
    batchId: string;
    kind: DocKind;
    supplierId: string;
    supplier: { vat_number: string | null; currency: string };
    rules: DocNumberRules;
    parsed: { rows: ParsedDocRow[]; control: DocControl; warnings: string[] };
    columnMapping?: unknown;
    sheetName?: string;
    tolerance?: string;
  },
) {
  const existing = await loadExistingDocKeys(supabase, args.kind, args.supplierId);
  const { records, counts, documents } = buildDocStagingRows(args.kind, args.parsed.rows, {
    rules: args.rules,
    supplier: args.supplier,
    existing,
    control: args.parsed.control,
    tolerance: args.tolerance,
  });

  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500).map((r) => ({ ...r, batch_id: args.batchId }));
    const { error } = await supabase.from("import_staging_rows").insert(chunk);
    if (error) throw error;
  }
  const { error } = await supabase
    .from("import_batches")
    .update({
      status: "staged",
      total_rows: records.length,
      valid_rows: counts.valid,
      error_rows: counts.errors,
      duplicate_rows: counts.duplicates,
      control: { documents, ...args.parsed.control, warnings: args.parsed.warnings.slice(0, 20) },
      column_mapping: args.columnMapping ?? null,
      sheet_name: args.sheetName ?? null,
      error_message: null,
    })
    .eq("id", args.batchId);
  if (error) throw error;
  return { total: records.length, documents, ...counts };
}
