"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, isUuid, UserError, userMessage, withParams } from "@/lib/forms";
import { downloadImportFile, detectKind, sha256 } from "@/lib/import/files";
import { extractPdfLines } from "@/lib/import/pdf";
import { cellToText, readTabular } from "@/lib/import/tabular";
import { DOC_FIELDS, DOC_KINDS, rowsToDocs, type DocField, type DocKind, type DocMapping } from "@/lib/import/doc-types";
import { isTaxInvoicePdf, parseTaxInvoiceLines } from "@/lib/import/invoice-pdf";
import { stageDocBatch } from "@/lib/import/doc-staging";
import type { DocNumberRules } from "@/lib/reconcile/normalize";
import type { ImportBatch } from "@/lib/types";

const EDITORS = ["admin", "accountant"] as const;
type Supa = Awaited<ReturnType<typeof createClient>>;

const isKind = (v: string): v is DocKind => (DOC_KINDS as string[]).includes(v);

async function loadContext(supabase: Supa, supplierId: string) {
  const [{ data: supplier }, { data: settings }] = await Promise.all([
    supabase.from("suppliers").select("id, code, name, vat_number, currency").eq("id", supplierId).is("deleted_at", null).maybeSingle(),
    supabase.from("app_settings").select("doc_number_rules, vat_rate, amount_tolerance_abs").eq("id", true).maybeSingle(),
  ]);
  if (!supplier) throw new UserError("Supplier not found.");
  return {
    supplier,
    rules: (settings?.doc_number_rules ?? {}) as DocNumberRules,
    vatRate: String(settings?.vat_rate ?? "0.15"),
    tolerance: String(settings?.amount_tolerance_abs ?? "0.05"),
  };
}

const startSchema = z.object({
  supplier_id: z.string().uuid(),
  kind: z.string(),
  files: z.array(z.object({ path: z.string().min(3).max(300), name: z.string().trim().min(1).max(255) })).min(1).max(30),
});

type FileResult = { name: string; ok: boolean; batchId?: string; message: string; target?: string };

async function processOne(
  supabase: Supa,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  supplierId: string,
  kind: DocKind,
  file: { path: string; name: string },
): Promise<FileResult> {
  let batchId: string | null = null;
  try {
    if (!file.path.startsWith(`${supplierId}/`) || file.path.includes("..")) throw new UserError("Invalid file location.");
    const buf = await downloadImportFile(supabase, file.path);
    const fileKind = detectKind(file.name, buf);
    const hash = sha256(buf);

    const { data: dup } = await supabase
      .from("import_batches")
      .select("id, status")
      .eq("supplier_id", supplierId)
      .eq("import_type", kind)
      .eq("file_hash", hash)
      .not("status", "in", "(failed,reverted)")
      .maybeSingle();
    if (dup) return { name: file.name, ok: false, batchId: dup.id, message: "Already uploaded before — not imported again.", target: `/suppliers/${supplierId}/documents/import/${dup.id}` };

    const { data: batch, error } = await supabase
      .from("import_batches")
      .insert({ supplier_id: supplierId, period_id: null, import_type: kind, file_name: file.name.slice(0, 255), file_kind: fileKind, storage_path: file.path, file_hash: hash, status: "uploaded" })
      .select("id")
      .single();
    if (error || !batch) {
      if (error?.code === "23505") throw new UserError("This exact file has already been imported.");
      throw error ?? new Error("batch insert failed");
    }
    batchId = batch.id as string;
    const review = `/suppliers/${supplierId}/documents/import/${batchId}`;

    if (fileKind === "pdf") {
      if (kind !== "invoice") throw new UserError("PDF files are only supported for supplier invoices. Upload an Excel (.xlsx) or CSV file for this document type.");
      const lines = await extractPdfLines(new Uint8Array(buf));
      if (lines.length === 0) throw new UserError("This PDF contains no readable text (it may be a scan or photo). Ask the supplier for a text-based PDF.");
      if (!isTaxInvoicePdf(lines)) throw new UserError("This PDF does not look like a supported tax invoice. Upload an Excel/CSV list of invoices instead, or share a sample so a reader can be added.");
      const parsed = parseTaxInvoiceLines(lines);
      if (parsed.rows.length === 0) throw new UserError("No invoice lines were recognised in this PDF.");
      const res = await stageDocBatch(supabase, { batchId, kind, supplierId, supplier: ctx.supplier, rules: ctx.rules, parsed, tolerance: ctx.tolerance });
      return { name: file.name, ok: res.errors === 0, batchId, message: res.errors ? `${res.errors} line(s) need attention.` : res.duplicates ? "Already imported." : "Ready to import.", target: review };
    }
    await supabase.from("import_batches").update({ status: "needs_mapping" }).eq("id", batchId);
    return { name: file.name, ok: true, batchId, message: "Needs column mapping.", target: `${review}/map` };
  } catch (e) {
    const message = e instanceof UserError ? e.message : "Unexpected error while reading the file.";
    if (batchId) await supabase.from("import_batches").update({ status: "failed", error_message: message }).eq("id", batchId);
    return { name: file.name, ok: false, message };
  }
}

/** One or several files were uploaded to private storage; read and stage each of them. */
export async function startDocImport(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const supplierId = fields.supplier_id ?? "";
  const kind = fields.kind ?? "";
  const uploadPage = `/suppliers/${supplierId}/documents/${kind}/import`;
  if (!isUuid(supplierId) || !isKind(kind)) redirect("/suppliers");

  let files: unknown;
  try {
    files = JSON.parse(fields.files ?? "[]");
  } catch {
    files = [];
  }
  const p = startSchema.safeParse({ supplier_id: supplierId, kind, files });
  if (!p.success) redirect(withParams(uploadPage, { error: "The upload was incomplete. Please try again." }));

  const supabase = await createClient();
  let target: string;
  try {
    const ctx = await loadContext(supabase, supplierId);
    const results: FileResult[] = [];
    for (const f of p.data.files) results.push(await processOne(supabase, ctx, supplierId, kind, f));

    if (results.length === 1) {
      const r = results[0];
      target = r.target ? r.target : withParams(uploadPage, { error: `${r.name}: ${r.message}` });
    } else {
      const failed = results.filter((r) => !r.batchId);
      target = withParams(`/suppliers/${supplierId}/documents/${kind}`, {
        notice: `${results.length - failed.length} of ${results.length} files were read. Review the imports below.`,
        error: failed.length ? failed.map((r) => `${r.name}: ${r.message}`).join(" | ").slice(0, 600) : undefined,
      });
    }
  } catch (e) {
    target = withParams(uploadPage, { error: userMessage(e, "The files could not be processed.") });
  }
  redirect(target);
}

/* ---------------- column mapping (spreadsheets) ---------------- */
const mappingSchema = z.object({
  batch_id: z.string().uuid(),
  supplier_id: z.string().uuid(),
  kind: z.string(),
  sheet: z.string().max(200).optional(),
  header_row: z.coerce.number().int().min(1).max(200),
  date_format: z.enum(["dmy", "mdy", "iso"]),
});

export async function applyDocMapping(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const mapPage = `/suppliers/${fields.supplier_id ?? ""}/documents/import/${fields.batch_id ?? ""}/map`;
  const p = mappingSchema.safeParse(fields);
  if (!p.success || !isKind(p.data.kind)) redirect(withParams(mapPage, { error: "Please complete the mapping form." }));
  const input = p.data;
  const kind = input.kind as DocKind;

  const columns: Partial<Record<DocField, number>> = {};
  for (const f of DOC_FIELDS[kind]) {
    const v = fields[`col_${f.key}`];
    if (v !== undefined && v !== "") {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0) columns[f.key] = n;
    }
  }

  const supabase = await createClient();
  let target: string;
  try {
    for (const f of DOC_FIELDS[kind]) if (f.required && columns[f.key] === undefined) throw new UserError(`Choose the column for "${f.label}".`);
    if (kind === "invoice" && columns.net === undefined && columns.gross === undefined) throw new UserError("Choose the amount column (excluding or including VAT).");

    const { data: batch } = await supabase.from("import_batches").select("*").eq("id", input.batch_id).eq("supplier_id", input.supplier_id).maybeSingle<ImportBatch>();
    if (!batch || batch.status !== "needs_mapping") throw new UserError("This import is not waiting for a column mapping.");
    const ctx = await loadContext(supabase, input.supplier_id);
    const buf = await downloadImportFile(supabase, batch.storage_path);
    const table = await readTabular(buf, batch.file_kind === "csv" ? "csv" : "xlsx", input.sheet || undefined);
    const headerIdx = input.header_row - 1;
    const headers = (table.rows[headerIdx] ?? []).map((c) => cellToText(c).trim());
    const dataRows = table.rows.slice(headerIdx + 1);
    if (dataRows.length === 0) throw new UserError("No data rows were found below the header row.");

    const mapping: DocMapping = {
      headerRow: input.header_row,
      columns,
      dateFormat: input.date_format,
      negativeIsCredit: fields.negative_is_credit === "on",
      sheet: table.sheetName,
    };
    const rows = rowsToDocs(kind, dataRows, headers, mapping, input.header_row + 1, ctx.vatRate);
    if (rows.length === 0) throw new UserError("No data rows were found below the header row.");

    await stageDocBatch(supabase, {
      batchId: batch.id, kind, supplierId: input.supplier_id, supplier: ctx.supplier, rules: ctx.rules,
      parsed: { rows, control: {}, warnings: [] }, columnMapping: mapping, sheetName: table.sheetName, tolerance: ctx.tolerance,
    });
    if (fields.save_template === "on") {
      await supabase.from("import_mapping_templates").upsert({ supplier_id: input.supplier_id, import_type: kind, mapping }, { onConflict: "supplier_id,import_type" });
    }
    target = `/suppliers/${input.supplier_id}/documents/import/${batch.id}`;
  } catch (e) {
    target = withParams(mapPage, { error: userMessage(e, "The file could not be processed with this mapping.") });
  }
  redirect(target);
}

/* ---------------- commit and revert ---------------- */
const reviewUrl = (f: Record<string, string>, extra: Record<string, string | undefined> = {}) =>
  withParams(`/suppliers/${f.supplier_id}/documents/import/${f.batch_id}`, extra);

export async function commitDocImport(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("commit_document_batch", { p_batch_id: f.batch_id });
  if (error) redirect(reviewUrl(f, { error: error.message }));
  const r = (data ?? {}) as { documents?: number; lines?: number; skipped_rows?: number };
  revalidatePath(`/suppliers/${f.supplier_id}`);
  redirect(reviewUrl(f, { done: `${r.documents ?? 0}:${r.lines ?? 0}:${r.skipped_rows ?? 0}` }));
}

/** Import every batch of this type that is ready and has no problem rows. */
export async function commitAllClean(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const kind = f.kind ?? "";
  const back = `/suppliers/${f.supplier_id}/documents/${kind}`;
  if (!isUuid(f.supplier_id ?? "") || !isKind(kind)) redirect("/suppliers");
  const supabase = await createClient();
  const { data: batches } = await supabase
    .from("import_batches").select("id").eq("supplier_id", f.supplier_id).eq("import_type", kind).eq("status", "staged").eq("error_rows", 0).gt("valid_rows", 0);
  let ok = 0;
  const failures: string[] = [];
  for (const b of batches ?? []) {
    const { error } = await supabase.rpc("commit_document_batch", { p_batch_id: b.id });
    if (error) failures.push(error.message); else ok++;
  }
  revalidatePath(back);
  redirect(withParams(back, { notice: `${ok} import(s) completed.`, error: failures.length ? failures.join(" | ").slice(0, 500) : undefined }));
}

export async function revertDocImport(formData: FormData) {
  await requireRole(["admin"]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("revert_document_batch", { p_batch_id: f.batch_id, p_reason: f.reason ?? "" });
  if (error) redirect(reviewUrl(f, { error: error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}`);
  redirect(reviewUrl(f, { reverted: "1" }));
}
