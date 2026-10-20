import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { downloadImportFile } from "@/lib/import/files";
import { cellToText, detectHeaderRow, readTabular } from "@/lib/import/tabular";
import { DOC_FIELDS, DOC_KIND_LABEL, guessDocColumns, type DocField, type DocKind, type DocMapping } from "@/lib/import/doc-types";
import { Alert, Breadcrumbs, Field } from "@/components/ui";
import type { ImportBatch } from "@/lib/types";
import { applyDocMapping } from "../../../actions";

export const maxDuration = 60;

function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export default async function MapDocColumnsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; batchId: string }>;
  searchParams: Promise<{ error?: string; sheet?: string; header_row?: string }>;
}) {
  await requireRole(["admin", "accountant"]);
  const { id, batchId } = await params;
  const sp = await searchParams;
  if (!isUuid(id) || !isUuid(batchId)) notFound();

  const supabase = await createClient();
  const { data: batch } = await supabase.from("import_batches").select("*").eq("id", batchId).eq("supplier_id", id).maybeSingle<ImportBatch>();
  if (!batch || !["po", "dn", "invoice", "payment"].includes(batch.import_type)) notFound();
  if (batch.status !== "needs_mapping") redirect(`/suppliers/${id}/documents/import/${batchId}`);
  const kind = batch.import_type as DocKind;

  let table;
  let loadError: string | null = null;
  try {
    const buf = await downloadImportFile(supabase, batch.storage_path);
    table = await readTabular(buf, batch.file_kind === "csv" ? "csv" : "xlsx", sp.sheet);
  } catch {
    loadError = "The file could not be read. It may be damaged or password-protected.";
  }
  const { data: template } = await supabase.from("import_mapping_templates").select("mapping").eq("supplier_id", id).eq("import_type", kind).maybeSingle();
  const saved = template?.mapping as DocMapping | undefined;

  const crumbs = [{ href: "/suppliers", label: "Suppliers" }, { href: `/suppliers/${id}/documents/${kind}`, label: DOC_KIND_LABEL[kind] }, { label: "Map columns" }];
  if (!table || loadError || table.rows.length === 0) {
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <Alert kind="error">{loadError ?? "The file has no data."}</Alert>
        <a className="btn-secondary" href={`/suppliers/${id}/documents/${kind}/import`}>Upload a different file</a>
      </div>
    );
  }

  const headerRow = Math.min(Math.max(1, Number.parseInt(sp.header_row ?? "", 10) || saved?.headerRow || detectHeaderRow(table.rows)), table.rows.length);
  const headers = (table.rows[headerRow - 1] ?? []).map((c) => cellToText(c).trim());
  const preview = table.rows.slice(headerRow, headerRow + 6);
  const guess: Partial<Record<DocField, number>> = saved?.columns && saved.headerRow === headerRow ? saved.columns : guessDocColumns(kind, headers);
  const colCount = Math.max(headers.length, ...preview.map((r) => r.length));
  const options = Array.from({ length: colCount }, (_, i) => ({ value: i, label: `${columnLetter(i)}: ${headers[i] || "(no heading)"}` }));

  return (
    <div className="space-y-4">
      <Breadcrumbs items={crumbs} />
      <h1 className="text-xl font-semibold">Match the columns in {batch.file_name}</h1>
      <p className="text-sm text-slate-600">
        Tell the system which column holds which information. {kind !== "payment" && "Rows with the same document number are treated as lines of one document. "}The choice is remembered for next time.
      </p>
      {sp.error && <Alert kind="error">{sp.error}</Alert>}

      <form className="card flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
        {table.sheetNames.length > 1 && (
          <Field label="Sheet" htmlFor="sheet" className="flex-1">
            <select id="sheet" name="sheet" defaultValue={table.sheetName} className="input">
              {table.sheetNames.map((n) => <option key={n}>{n}</option>)}
            </select>
          </Field>
        )}
        <Field label="Row that contains the column headings" htmlFor="header_row" className="flex-1">
          <input id="header_row" name="header_row" type="number" min={1} max={200} defaultValue={headerRow} className="input" />
        </Field>
        <button className="btn-secondary" type="submit">Reload preview</button>
      </form>

      <div className="card overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              {options.map((o) => <th key={o.value} className="whitespace-nowrap px-3 py-2 font-medium">{o.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.map((r, ri) => (
              <tr key={ri} className="border-b border-slate-100 last:border-0">
                {options.map((o) => <td key={o.value} className="whitespace-nowrap px-3 py-1.5">{cellToText(r[o.value] ?? null)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form action={applyDocMapping} className="card grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="batch_id" value={batchId} />
        <input type="hidden" name="supplier_id" value={id} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="sheet" value={table.sheetName} />
        <input type="hidden" name="header_row" value={headerRow} />

        {DOC_FIELDS[kind].map((f) => (
          <Field key={f.key} label={f.label + (f.required ? " *" : "")} htmlFor={`col_${f.key}`} hint={f.hint}>
            <select id={`col_${f.key}`} name={`col_${f.key}`} defaultValue={guess[f.key] ?? ""} className="input">
              <option value="">— not in this file —</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        ))}

        <Field label="Date format in the file" htmlFor="date_format" hint="Real Excel dates are read automatically.">
          <select id="date_format" name="date_format" defaultValue={saved?.dateFormat ?? "dmy"} className="input">
            <option value="dmy">Day / Month / Year (31/12/2026)</option>
            <option value="mdy">Month / Day / Year (12/31/2026)</option>
            <option value="iso">Year-Month-Day (2026-12-31)</option>
          </select>
        </Field>
        {kind === "invoice" && (
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" name="negative_is_credit" defaultChecked={saved?.negativeIsCredit} className="h-4 w-4 rounded border-slate-300" />
            Negative amounts are credit notes
          </label>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="save_template" defaultChecked className="h-4 w-4 rounded border-slate-300" />
          Remember this mapping for this supplier
        </label>
        <div className="sm:col-span-2"><button className="btn" type="submit">Check the file</button></div>
      </form>
    </div>
  );
}
