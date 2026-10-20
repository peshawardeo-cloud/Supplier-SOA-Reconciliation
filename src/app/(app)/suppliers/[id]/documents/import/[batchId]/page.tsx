import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid, withParams } from "@/lib/forms";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, ImportStatusPill, Pill } from "@/components/ui";
import { DOC_KIND_LABEL, type DocKind } from "@/lib/import/doc-types";
import type { ImportBatch } from "@/lib/types";
import type { RowIssue } from "@/lib/import/types";
import { commitDocImport, revertDocImport } from "../../actions";

const PAGE_SIZE = 100;
const FILTERS = [["all", "All rows"], ["errors", "Errors"], ["duplicates", "Already imported"], ["ready", "Ready"]] as const;

type SRow = {
  id: string;
  row_number: number;
  status: "valid" | "error" | "duplicate";
  issues: RowIssue[];
  mapped: Record<string, string | null>;
};

export default async function DocImportReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; batchId: string }>;
  searchParams: Promise<{ error?: string; done?: string; reverted?: string; show?: string; page?: string }>;
}) {
  const { id, batchId } = await params;
  const sp = await searchParams;
  if (!isUuid(id) || !isUuid(batchId)) notFound();
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const isAdmin = profile?.role === "admin";

  const supabase = await createClient();
  const { data: batch } = await supabase.from("import_batches").select("*").eq("id", batchId).eq("supplier_id", id).maybeSingle<ImportBatch>();
  if (!batch || !["po", "dn", "invoice", "payment"].includes(batch.import_type)) notFound();
  const kind = batch.import_type as DocKind;
  const { data: supplier } = await supabase.from("suppliers").select("code, name").eq("id", id).maybeSingle();

  const show = FILTERS.some(([k]) => k === sp.show) ? (sp.show as string) : batch.error_rows > 0 ? "errors" : "all";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  let rq = supabase.from("import_staging_rows").select("id, row_number, mapped, status, issues", { count: "exact" }).eq("batch_id", batchId).order("row_number").range(from, from + PAGE_SIZE - 1);
  if (show === "errors") rq = rq.eq("status", "error");
  else if (show === "duplicates") rq = rq.eq("status", "duplicate");
  else if (show === "ready") rq = rq.eq("status", "valid");
  const { data: rows, count } = await rq.returns<SRow[]>();

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const staged = batch.status === "staged";
  const here = `/suppliers/${id}/documents/import/${batchId}`;
  const hidden = { supplier_id: id, batch_id: batchId };
  const documents = Number((batch.control as { documents?: number } | null)?.documents ?? 0);
  const ctl = (batch.control ?? {}) as { sellerVat?: string; supplierName?: string; warnings?: string[] };

  let done: string | null = null;
  if (sp.done) {
    const [docs, lines, skipped] = sp.done.split(":");
    done = `Imported ${docs} document(s) (${lines} lines).${Number(skipped) > 0 ? ` ${skipped} row(s) were not imported (errors or already on file).` : ""}`;
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { href: `/suppliers/${id}`, label: supplier?.code ?? "Supplier" }, { href: `/suppliers/${id}/documents/${kind}`, label: DOC_KIND_LABEL[kind] }, { label: "Import review" }]} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="break-all text-xl font-semibold">{batch.file_name}</h1>
          <p className="text-sm text-slate-600">{DOC_KIND_LABEL[kind]} · uploaded {fmtDateTime(batch.created_at)} · {batch.file_kind.toUpperCase()}{batch.committed_at && ` · imported ${fmtDateTime(batch.committed_at)}`}</p>
        </div>
        <ImportStatusPill status={batch.status} />
      </div>

      {sp.error && <Alert kind="error">{sp.error}</Alert>}
      {done && <Alert kind="success">{done}</Alert>}
      {sp.reverted && <Alert kind="success">Import reverted. The documents were removed from use; the history is kept.</Alert>}
      {batch.status === "failed" && <Alert kind="error">{batch.error_message ?? "This import failed."}</Alert>}
      {batch.status === "reverted" && <Alert kind="info">Reverted: {batch.revert_reason}</Alert>}
      {batch.status === "needs_mapping" && <Alert kind="warning">This file still needs its columns matched. <Link className="underline" href={`${here}/map`}>Match columns</Link></Alert>}

      {batch.status !== "failed" && batch.status !== "needs_mapping" && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [kind === "payment" ? "Payments ready" : "Documents ready", String(documents)],
              ["Rows ready", String(batch.valid_rows)],
              ["Rows with errors", String(batch.error_rows)],
              ["Already on file", String(batch.duplicate_rows)],
            ].map(([label, value]) => (
              <div key={label} className="card !p-3">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="text-xl font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </section>
          {ctl.sellerVat && <p className="text-xs text-slate-500">Seller VAT number on the document: {ctl.sellerVat}</p>}
          {batch.error_rows > 0 && staged && <Alert kind="warning">Documents with an error are held back completely. Fix the file and upload it again, or import the clean ones now.</Alert>}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            {FILTERS.map(([k, label]) => (
              <Link key={k} href={withParams(here, { show: k })} className={k === show ? "rounded-full bg-blue-700 px-3 py-1 text-white" : "rounded-full bg-slate-100 px-3 py-1 text-slate-700"}>{label}</Link>
            ))}
          </div>

          <div className="card overflow-x-auto p-0 sm:p-0">
            <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                  <th className="px-3 py-2">Row</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Number</th><th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Item</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Net</th><th className="px-3 py-2 text-right">VAT</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="px-3 py-1.5">{r.row_number}</td>
                    <td className="px-3 py-1.5"><Pill tone={r.status === "valid" ? "green" : r.status === "error" ? "red" : "amber"}>{r.status === "valid" ? "Ready" : r.status === "error" ? "Error" : "On file"}</Pill></td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-medium">{r.mapped.doc_number}{r.mapped.doc_type === "credit_note" && <span className="text-amber-700"> (credit note)</span>}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.mapped.doc_date}</td>
                    <td className="px-3 py-1.5">{r.mapped.item_code ?? r.mapped.description}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.mapped.qty}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.mapped.net ? fmtMoney(r.mapped.net) : ""}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.mapped.vat ? fmtMoney(r.mapped.vat) : ""}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.mapped.gross ? fmtMoney(r.mapped.gross) : ""}</td>
                    <td className="px-3 py-1.5">{(r.issues ?? []).map((i, n) => <div key={n} className={i.severity === "error" ? "text-red-700" : "text-amber-700"}>{i.message}</div>)}</td>
                  </tr>
                ))}
                {(rows ?? []).length === 0 && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-500">No rows in this view.</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-3 text-sm">
              {page > 1 && <Link className="btn-secondary" href={withParams(here, { show, page: String(page - 1) })}>Previous</Link>}
              <span>Page {page} of {pages}</span>
              {page < pages && <Link className="btn-secondary" href={withParams(here, { show, page: String(page + 1) })}>Next</Link>}
            </div>
          )}
        </>
      )}

      {staged && canEdit && (
        <form action={commitDocImport} className="card flex flex-wrap items-center gap-3">
          {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <button className="btn" type="submit" disabled={batch.valid_rows === 0}>Import {documents} {DOC_KIND_LABEL[kind].toLowerCase()}</button>
          <span className="text-sm text-slate-600">{batch.valid_rows === 0 ? "Nothing is ready to import." : "Imported documents cannot be edited afterwards."}</span>
        </form>
      )}

      {batch.status === "committed" && isAdmin && (
        <form action={revertDocImport} className="card space-y-2 border-red-200">
          {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <h2 className="font-semibold text-red-800">Revert this import (administrator)</h2>
          <p className="text-xs text-slate-600">Documents are marked removed, never deleted. This is refused if payments or credit notes are already applied to them.</p>
          <input name="reason" required minLength={3} placeholder="Reason (required)" className="input" />
          <button className="btn-secondary" type="submit">Revert import</button>
        </form>
      )}
    </div>
  );
}
