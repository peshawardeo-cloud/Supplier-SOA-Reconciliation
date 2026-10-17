import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDocNumber, type DocNumberRules } from "@/lib/reconcile/normalize";
import { compareSoaControl } from "./soa-text";
import type { ParsedSoa, ParsedSoaRow, RowIssue, SoaControl } from "./types";

export type StagingRecord = {
  row_number: number;
  raw: Record<string, unknown>;
  mapped: Record<string, unknown>;
  status: "valid" | "error" | "duplicate";
  issues: RowIssue[];
  duplicate_of: string | null;
};

type Ctx = {
  rules: DocNumberRules;
  supplier: { account_ref: string | null; currency: string };
  period: { start: string; end: string };
  /** `${entry_type}|${doc_number_norm}` -> id of the entry already imported in this period */
  existing: Map<string, string>;
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");

/** Does the statement's printed supplier name / account number match the supplier it is being imported for? */
export function checkSupplierIdentity(
  control: SoaControl,
  supplier: { name: string; code: string; account_ref: string | null },
  aliases: string[],
): { name_match: boolean | null; account_match: boolean | null } {
  let name_match: boolean | null = null;
  if (control.supplierName) {
    const printed = squash(control.supplierName);
    const candidates = [supplier.name, supplier.code, ...aliases].map(squash).filter((c) => c.length >= 3);
    name_match = candidates.some((c) => printed.includes(c) || c.includes(printed));
  }
  let account_match: boolean | null = null;
  if (control.accountRef && supplier.account_ref) {
    account_match = control.accountRef.trim() === supplier.account_ref.trim();
  }
  return { name_match, account_match };
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

/** Pure step: decide for every parsed row whether it is valid, has errors, or is a duplicate. */
export function buildStagingRows(rows: ParsedSoaRow[], ctx: Ctx) {
  const records: StagingRecord[] = [];
  const seenInFile = new Set<string>();
  let valid = 0;
  let errors = 0;
  let duplicates = 0;
  let outsidePeriod = 0;

  for (const r of rows) {
    const issues: RowIssue[] = [...r.issues];
    const norm = r.docNumber ? normalizeDocNumber(r.docNumber, ctx.rules) : "";
    const key = `${r.entryType}|${norm}`;

    if (r.docDate && (r.docDate < ctx.period.start || r.docDate > ctx.period.end)) outsidePeriod += 1;

    if (r.accountRef && ctx.supplier.account_ref && r.accountRef !== ctx.supplier.account_ref) {
      issues.push({
        field: "account_ref",
        code: "account_mismatch",
        message: `Account ${r.accountRef} differs from this supplier's account ${ctx.supplier.account_ref}.`,
        severity: "warning",
      });
    }
    if (r.currency && r.currency !== ctx.supplier.currency) {
      issues.push({
        field: "currency",
        code: "currency_mismatch",
        message: `Currency ${r.currency} differs from the supplier's currency ${ctx.supplier.currency}.`,
        severity: "warning",
      });
    }

    let status: StagingRecord["status"] = "valid";
    let duplicateOf: string | null = null;

    if (issues.some((i) => i.severity === "error")) {
      status = "error";
    } else if (ctx.existing.has(key)) {
      status = "duplicate";
      duplicateOf = ctx.existing.get(key) ?? null;
      issues.push({
        field: "doc_number",
        code: "already_imported",
        message: "This document is already in the period from an earlier import.",
        severity: "warning",
      });
    } else if (seenInFile.has(key)) {
      status = "duplicate";
      issues.push({
        field: "doc_number",
        code: "duplicate_in_file",
        message: "The same document number appears more than once in this file.",
        severity: "warning",
      });
    }
    if (status !== "error") seenInFile.add(key);

    const fingerprint = createHash("sha256")
      .update([r.entryType, norm, r.docDate, r.debit, r.credit, r.deliveryRef ?? "", r.accountRef ?? ""].join("|"))
      .digest("hex");

    if (status === "valid") valid += 1;
    else if (status === "error") errors += 1;
    else duplicates += 1;

    records.push({
      row_number: r.rowNumber,
      raw: parseRaw(r.raw),
      mapped: {
        entry_type: r.entryType,
        doc_number: r.docNumber,
        doc_number_norm: norm,
        doc_date: r.docDate,
        due_date: r.dueDate,
        account_ref: r.accountRef,
        delivery_ref: r.deliveryRef,
        po_ref: r.poRef,
        description: r.description,
        debit: r.debit,
        credit: r.credit,
        currency: r.currency,
        row_fingerprint: fingerprint,
      },
      status,
      issues,
      duplicate_of: duplicateOf,
    });
  }
  return { records, counts: { valid, errors, duplicates }, outsidePeriod };
}

async function loadExistingKeys(supabase: SupabaseClient, periodId: string) {
  const existing = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("soa_entries")
      .select("id, entry_type, doc_number_norm")
      .eq("period_id", periodId)
      .is("deleted_at", null)
      .range(from, from + 999);
    if (error) throw error;
    for (const e of data ?? []) existing.set(`${e.entry_type}|${e.doc_number_norm}`, e.id);
    if (!data || data.length < 1000) break;
  }
  return existing;
}

/** Store the parsed rows for review and mark the batch ready. Nothing is imported yet. */
export async function stageSoaBatch(
  supabase: SupabaseClient,
  args: {
    batchId: string;
    parsed: ParsedSoa;
    rules: DocNumberRules;
    supplier: { name: string; code: string; account_ref: string | null; currency: string };
    aliases: string[];
    period: { id: string; period_start: string; period_end: string };
    columnMapping?: unknown;
    sheetName?: string;
  },
) {
  const existing = await loadExistingKeys(supabase, args.period.id);
  const { records, counts, outsidePeriod } = buildStagingRows(args.parsed.rows, {
    rules: args.rules,
    supplier: args.supplier,
    period: { start: args.period.period_start, end: args.period.period_end },
    existing,
  });

  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500).map((r) => ({ ...r, batch_id: args.batchId }));
    const { error } = await supabase.from("import_staging_rows").insert(chunk);
    if (error) throw error;
  }

  const control = {
    ...args.parsed.control,
    checks: compareSoaControl(args.parsed.control, args.parsed.rows),
    identity: checkSupplierIdentity(args.parsed.control, args.supplier, args.aliases),
    outside_period_count: outsidePeriod,
    warnings: args.parsed.warnings.slice(0, 20),
  };

  const { error } = await supabase
    .from("import_batches")
    .update({
      status: "staged",
      total_rows: records.length,
      valid_rows: counts.valid,
      error_rows: counts.errors,
      duplicate_rows: counts.duplicates,
      control,
      column_mapping: args.columnMapping ?? null,
      sheet_name: args.sheetName ?? null,
      error_message: null,
    })
    .eq("id", args.batchId);
  if (error) throw error;

  return { total: records.length, ...counts };
}
