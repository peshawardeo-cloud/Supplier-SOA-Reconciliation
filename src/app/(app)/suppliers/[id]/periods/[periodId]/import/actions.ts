"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, isUuid, UserError, userMessage, withParams } from "@/lib/forms";
import { downloadImportFile, detectKind, sha256 } from "@/lib/import/files";
import { extractPdfLines } from "@/lib/import/pdf";
import { parseSoaLines } from "@/lib/import/soa-text";
import { cellToText, readTabular } from "@/lib/import/tabular";
import { SOA_FIELDS, rowsToSoa, type SoaField, type SoaMapping } from "@/lib/import/soa-mapping";
import { stageSoaBatch } from "@/lib/import/staging";
import { SOA_ENTRY_TYPES, type ParsedSoa } from "@/lib/import/types";
import { OPEN_PERIOD_STATUSES, type BatchControl, type ImportBatch, type PeriodStatus } from "@/lib/types";
import type { DocNumberRules } from "@/lib/reconcile/normalize";

const EDITORS = ["admin", "accountant"] as const;

const startSchema = z.object({
  supplier_id: z.string().uuid(),
  period_id: z.string().uuid(),
  storage_path: z.string().min(3).max(300),
  file_name: z.string().trim().min(1).max(255),
});

type Supa = Awaited<ReturnType<typeof createClient>>;

async function loadContext(supabase: Supa, supplierId: string, periodId: string) {
  const [{ data: supplier }, { data: period }, { data: settings }, { data: aliasRows }] = await Promise.all([
    supabase.from("suppliers").select("id, code, name, account_ref, currency").eq("id", supplierId).is("deleted_at", null).maybeSingle(),
    supabase.from("reconciliation_periods").select("id, status, period_start, period_end").eq("id", periodId).eq("supplier_id", supplierId).maybeSingle(),
    supabase.from("app_settings").select("doc_number_rules").eq("id", true).maybeSingle(),
    supabase.from("supplier_aliases").select("alias_name").eq("supplier_id", supplierId),
  ]);
  if (!supplier || !period) throw new UserError("Supplier or period not found.");
  if (!OPEN_PERIOD_STATUSES.includes(period.status as PeriodStatus)) {
    throw new UserError("This period is not open for imports. Change its status to Draft or In progress first.");
  }
  return {
    supplier,
    period,
    rules: (settings?.doc_number_rules ?? {}) as DocNumberRules,
    aliases: (aliasRows ?? []).map((a) => a.alias_name as string),
  };
}

async function failBatch(supabase: Supa, batchId: string, message: string) {
  await supabase.from("import_batches").update({ status: "failed", error_message: message }).eq("id", batchId);
}

/* ------------------------------------------------------------------ */
/* Step 1: a file was uploaded to private storage; read it and stage it */
/* ------------------------------------------------------------------ */
export async function startSoaImport(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const supplierId = fields.supplier_id ?? "";
  const periodId = fields.period_id ?? "";
  const base = `/suppliers/${supplierId}/periods/${periodId}`;
  const uploadPage = `${base}/import/soa`;

  const parsedInput = startSchema.safeParse(fields);
  if (!parsedInput.success || !isUuid(supplierId) || !isUuid(periodId)) {
    redirect(withParams(uploadPage, { error: "The upload was incomplete. Please try again." }));
  }
  const input = parsedInput.data;

  let target: string;
  let batchId: string | null = null;
  const supabase = await createClient();

  try {
    if (!input.storage_path.startsWith(`${supplierId}/`) || input.storage_path.includes("..")) {
      throw new UserError("Invalid file location.");
    }
    const ctx = await loadContext(supabase, supplierId, periodId);
    const buf = await downloadImportFile(supabase, input.storage_path);
    const kind = detectKind(input.file_name, buf);
    const hash = sha256(buf);

    // The same file must never be imported twice for a supplier.
    const { data: dup } = await supabase
      .from("import_batches")
      .select("id, period_id")
      .eq("supplier_id", supplierId)
      .eq("import_type", "soa")
      .eq("file_hash", hash)
      .not("status", "in", "(failed,reverted)")
      .maybeSingle();
    if (dup) {
      target = withParams(`/suppliers/${supplierId}/periods/${dup.period_id}/import/${dup.id}`, { notice: "duplicate-file" });
    } else {
      const { data: batch, error: batchError } = await supabase
        .from("import_batches")
        .insert({
          supplier_id: supplierId,
          period_id: periodId,
          import_type: "soa",
          file_name: input.file_name.slice(0, 255),
          file_kind: kind,
          storage_path: input.storage_path,
          file_hash: hash,
          status: "uploaded",
        })
        .select("id")
        .single();
      if (batchError || !batch) {
        if (batchError?.code === "23505") throw new UserError("This exact file has already been imported for this supplier.");
        throw batchError ?? new Error("batch insert failed");
      }
      batchId = batch.id as string;

      if (kind === "pdf") {
        const lines = await extractPdfLines(new Uint8Array(buf));
        if (lines.length === 0) {
          throw new UserError("This PDF contains no readable text (it may be a scan or photo). Ask the supplier for the Excel/CSV version or a text-based PDF.");
        }
        const parsed = parseSoaLines(lines);
        if (parsed.rows.length === 0) {
          throw new UserError("No statement lines were recognised in this PDF. Its layout is not supported yet; please upload an Excel or CSV version, or share a sample so a reader can be added.");
        }
        await stageSoaBatch(supabase, { batchId, parsed, ...ctx, period: ctx.period });
        target = `${base}/import/${batchId}`;
      } else {
        await supabase.from("import_batches").update({ status: "needs_mapping" }).eq("id", batchId);
        target = `${base}/import/${batchId}/map`;
      }
    }
  } catch (e) {
    if (batchId) await failBatch(supabase, batchId, e instanceof UserError ? e.message : "Unexpected error while reading the file.");
    target = withParams(uploadPage, { error: userMessage(e, "The file could not be processed. Please try again or contact your administrator.") });
  }
  redirect(target);
}

/* ------------------------------------------------------------------ */
/* Step 2 (spreadsheets only): apply the user's column mapping          */
/* ------------------------------------------------------------------ */
const mappingSchema = z.object({
  batch_id: z.string().uuid(),
  supplier_id: z.string().uuid(),
  period_id: z.string().uuid(),
  sheet: z.string().max(200).optional(),
  header_row: z.coerce.number().int().min(1).max(200),
  date_format: z.enum(["dmy", "mdy", "iso"]),
  amount_mode: z.enum(["debit_credit", "signed"]),
  signed_positive: z.enum(["debit", "credit"]),
  default_type: z.enum(SOA_ENTRY_TYPES as [string, ...string[]]),
});

export async function applySoaMapping(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const base = `/suppliers/${fields.supplier_id ?? ""}/periods/${fields.period_id ?? ""}`;
  const mapPage = `${base}/import/${fields.batch_id ?? ""}/map`;

  const p = mappingSchema.safeParse(fields);
  if (!p.success) redirect(withParams(mapPage, { error: "Please complete the mapping form." }));
  const input = p.data;

  const columns: Partial<Record<SoaField, number>> = {};
  for (const f of SOA_FIELDS) {
    const v = fields[`col_${f.key}`];
    if (v !== undefined && v !== "") {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0) columns[f.key] = n;
    }
  }

  let target: string;
  const supabase = await createClient();
  try {
    if (columns.doc_date === undefined) throw new UserError("Choose the column that holds the document date.");
    if (columns.doc_number === undefined) throw new UserError("Choose the column that holds the document / invoice number.");
    if (input.amount_mode === "debit_credit" && columns.debit === undefined && columns.credit === undefined) {
      throw new UserError("Choose a debit and/or credit column, or switch to a single amount column.");
    }
    if (input.amount_mode === "signed" && columns.amount === undefined) {
      throw new UserError("Choose the amount column.");
    }

    const { data: batch } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", input.batch_id)
      .eq("supplier_id", input.supplier_id)
      .eq("period_id", input.period_id)
      .maybeSingle<ImportBatch>();
    if (!batch || batch.status !== "needs_mapping") throw new UserError("This import is not waiting for a column mapping.");

    const ctx = await loadContext(supabase, input.supplier_id, input.period_id);
    const buf = await downloadImportFile(supabase, batch.storage_path);
    const table = await readTabular(buf, batch.file_kind === "csv" ? "csv" : "xlsx", input.sheet || undefined);

    const headerIdx = input.header_row - 1;
    const headers = (table.rows[headerIdx] ?? []).map((c) => cellToText(c).trim());
    const dataRows = table.rows.slice(headerIdx + 1);
    if (dataRows.length === 0) throw new UserError("No data rows were found below the header row.");

    const mapping: SoaMapping = {
      headerRow: input.header_row,
      columns,
      dateFormat: input.date_format,
      amountMode: input.amount_mode,
      signedPositive: input.signed_positive,
      defaultType: input.default_type as SoaMapping["defaultType"],
      sheet: table.sheetName,
    };
    const rows = rowsToSoa(dataRows, headers, mapping, input.header_row + 1);
    if (rows.length === 0) throw new UserError("No data rows were found below the header row.");

    const parsed: ParsedSoa = { rows, control: {}, warnings: [] };
    await stageSoaBatch(supabase, {
      batchId: batch.id,
      parsed,
      ...ctx,
      period: ctx.period,
      columnMapping: mapping,
      sheetName: table.sheetName,
    });

    if (fields.save_template === "on") {
      await supabase
        .from("import_mapping_templates")
        .upsert({ supplier_id: input.supplier_id, import_type: "soa", mapping }, { onConflict: "supplier_id,import_type" });
    }
    target = `${base}/import/${batch.id}`;
  } catch (e) {
    target = withParams(mapPage, { error: userMessage(e, "The file could not be processed with this mapping.") });
  }
  redirect(target);
}

/* ------------------------------------------------------------------ */
/* Step 3: review decisions and commit                                  */
/* ------------------------------------------------------------------ */
function reviewUrl(fields: Record<string, string>, extra: Record<string, string | undefined> = {}) {
  return withParams(`/suppliers/${fields.supplier_id}/periods/${fields.period_id}/import/${fields.batch_id}`, extra);
}

export async function decideDuplicate(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const decision = f.decision === "import" ? "import" : "skip";
  const supabase = await createClient();

  const { data: batch } = await supabase.from("import_batches").select("status").eq("id", f.batch_id).maybeSingle();
  if (batch?.status !== "staged") redirect(reviewUrl(f, { error: "This import can no longer be changed." }));

  const { error } = await supabase
    .from("import_staging_rows")
    .update({ user_decision: decision })
    .eq("id", f.row_id)
    .eq("batch_id", f.batch_id)
    .eq("status", "duplicate");
  if (error) redirect(reviewUrl(f, { error: "Could not save your decision." }));

  revalidatePath(`/suppliers/${f.supplier_id}/periods/${f.period_id}/import/${f.batch_id}`);
  redirect(reviewUrl(f, { show: f.show || "duplicates", page: f.page || undefined }));
}

export async function decideAllDuplicates(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const decision = f.decision === "import" ? "import" : "skip";
  const supabase = await createClient();

  const { data: batch } = await supabase.from("import_batches").select("status").eq("id", f.batch_id).maybeSingle();
  if (batch?.status !== "staged") redirect(reviewUrl(f, { error: "This import can no longer be changed." }));

  const { error } = await supabase
    .from("import_staging_rows")
    .update({ user_decision: decision })
    .eq("batch_id", f.batch_id)
    .eq("status", "duplicate");
  if (error) redirect(reviewUrl(f, { error: "Could not save your decision." }));

  redirect(reviewUrl(f, { show: "duplicates" }));
}

export async function commitImport(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const supabase = await createClient();

  const { data: batch } = await supabase
    .from("import_batches")
    .select("*")
    .eq("id", f.batch_id)
    .eq("supplier_id", f.supplier_id)
    .eq("period_id", f.period_id)
    .maybeSingle<ImportBatch>();
  if (!batch) redirect(reviewUrl(f, { error: "Import not found." }));

  const control: BatchControl = batch.control ?? {};
  const needsConfirm =
    (control.checks ?? []).some((c) => !c.ok) ||
    control.identity?.name_match === false ||
    control.identity?.account_match === false;
  if (needsConfirm && f.confirm !== "on") {
    redirect(reviewUrl(f, { error: "Please tick the confirmation box to import despite the warnings." }));
  }

  const { data, error } = await supabase.rpc("commit_import_batch", { p_batch_id: batch.id });
  if (error) redirect(reviewUrl(f, { error: error.message }));

  // Fill in the supplier-reported figures from the statement, but never overwrite what a person entered.
  if (control.closingBalance !== undefined) {
    await supabase
      .from("reconciliation_periods")
      .update({ reported_closing_balance: control.closingBalance })
      .eq("id", f.period_id)
      .is("reported_closing_balance", null);
  }
  if (control.dateTo) {
    await supabase.from("reconciliation_periods").update({ statement_date: control.dateTo }).eq("id", f.period_id).is("statement_date", null);
  }

  const result = (data ?? {}) as { imported?: number; skipped_duplicates?: number };
  revalidatePath(`/suppliers/${f.supplier_id}/periods/${f.period_id}`);
  redirect(reviewUrl(f, { done: `${result.imported ?? 0}:${result.skipped_duplicates ?? 0}` }));
}

export async function revertImport(formData: FormData) {
  await requireRole(["admin"]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("revert_import_batch", { p_batch_id: f.batch_id, p_reason: f.reason ?? "" });
  if (error) redirect(reviewUrl(f, { error: error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/periods/${f.period_id}`);
  redirect(reviewUrl(f, { reverted: "1" }));
}
