import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid, withParams } from "@/lib/forms";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, ImportStatusPill, Pill } from "@/components/ui";
import type { BatchControl, ImportBatch } from "@/lib/types";
import type { RowIssue } from "@/lib/import/types";
import { commitImport, decideAllDuplicates, decideDuplicate, revertImport } from "../actions";

const PAGE_SIZE = 100;
const FILTERS = [
  ["all", "All rows"],
  ["errors", "Errors"],
  ["duplicates", "Duplicates"],
  ["ready", "Ready"],
] as const;

type StagingRow = {
  id: string;
  row_number: number;
  mapped: {
    entry_type?: string;
    doc_number?: string;
    doc_date?: string;
    delivery_ref?: string;
    debit?: string;
    credit?: string;
    description?: string;
  };
  status: "valid" | "error" | "duplicate";
  issues: RowIssue[];
  user_decision: "import" | "skip" | null;
};

export default async function ImportReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; periodId: string; batchId: string }>;
  searchParams: Promise<{ error?: string; notice?: string; done?: string; reverted?: string; show?: string; page?: string }>;
}) {
  const { id, periodId, batchId } = await params;
  const sp = await searchParams;
  if (!isUuid(id) || !isUuid(periodId) || !isUuid(batchId)) notFound();

  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const isAdmin = profile?.role === "admin";

  const supabase = await createClient();
  const { data: batch } = await supabase
    .from("import_batches")
    .select("*")
    .eq("id", batchId)
    .eq("supplier_id", id)
    .maybeSingle<ImportBatch>();
  if (!batch) notFound();
  // Opened from a different period (e.g. "this file was already imported there")? Use the batch's own period.
  const batchPeriodId = batch.period_id ?? periodId;

  const base = `/suppliers/${id}/periods/${batchPeriodId}`;
  const here = `${base}/import/${batchId}`;
  const control: BatchControl = batch.control ?? {};
  const show = FILTERS.some(([k]) => k === sp.show) ? (sp.show as string) : batch.error_rows > 0 ? "errors" : batch.duplicate_rows > 0 ? "duplicates" : "all";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  let rowQuery = supabase
    .from("import_staging_rows")
    .select("id, row_number, mapped, status, issues, user_decision", { count: "exact" })
    .eq("batch_id", batchId)
    .order("row_number")
    .range(from, from + PAGE_SIZE - 1);
  if (show === "errors") rowQuery = rowQuery.eq("status", "error");
  else if (show === "duplicates") rowQuery = rowQuery.eq("status", "duplicate");
  else if (show === "ready") rowQuery = rowQuery.eq("status", "valid");

  const [{ data: rows, count }, { count: importDupes }, { count: undecided }, { data: supplier }] = await Promise.all([
    rowQuery.returns<StagingRow[]>(),
    supabase.from("import_staging_rows").select("id", { count: "exact", head: true }).eq("batch_id", batchId).eq("status", "duplicate").eq("user_decision", "import"),
    supabase.from("import_staging_rows").select("id", { count: "exact", head: true }).eq("batch_id", batchId).eq("status", "duplicate").is("user_decision", null),
    supabase.from("suppliers").select("code, name").eq("id", id).maybeSingle(),
  ]);

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const staged = batch.status === "staged";
  const checks = control.checks ?? [];
  const checksFailed = checks.some((c) => !c.ok);
  const identityBad = control.identity?.name_match === false || control.identity?.account_match === false;
  const willImport = batch.valid_rows + (importDupes ?? 0);
  const hidden = { supplier_id: id, period_id: batchPeriodId, batch_id: batchId };
  const link = (over: Record<string, string | undefined>) => withParams(here, { show, ...over });

  let doneMsg: string | null = null;
  if (sp.done) {
    const [imp, skip] = sp.done.split(":");
    doneMsg = `Imported ${imp} entries.${Number(skip) > 0 ? ` ${skip} duplicate rows were skipped.` : ""}`;
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { href: "/suppliers", label: "Suppliers" },
          { href: `/suppliers/${id}`, label: supplier?.code ?? "Supplier" },
          { href: base, label: "Period" },
          { label: "Import review" },
        ]}
      />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="break-all text-xl font-semibold">{batch.file_name}</h1>
          <p className="text-sm text-slate-600">
            Uploaded {fmtDateTime(batch.created_at)} · {batch.file_kind.toUpperCase()}
            {batch.committed_at && ` · imported ${fmtDateTime(batch.committed_at)}`}
          </p>
        </div>
        <ImportStatusPill status={batch.status} />
      </div>

      {sp.error && <Alert kind="error">{sp.error}</Alert>}
      {sp.notice === "duplicate-file" && (
        <Alert kind="warning">This exact file was already uploaded for this supplier, so it was not imported again. This is the existing import.</Alert>
      )}
      {doneMsg && <Alert kind="success">{doneMsg}</Alert>}
      {sp.reverted && <Alert kind="success">Import reverted. Its entries were removed from the period; the history is kept.</Alert>}
      {batch.status === "failed" && <Alert kind="error">{batch.error_message ?? "This import failed."}</Alert>}
      {batch.status === "reverted" && <Alert kind="info">Reverted{batch.reverted_at ? ` on ${fmtDateTime(batch.reverted_at)}` : ""}: {batch.revert_reason}</Alert>}

      {batch.status !== "failed" && batch.status !== "needs_mapping" && (
        <>
          {/* ---------- Is this the right supplier? ---------- */}
          {(control.supplierName || control.accountRef) && (
            <section className={`card text-sm ${identityBad ? "border-amber-300 bg-amber-50" : ""}`}>
              <h2 className="mb-1 font-semibold">Supplier identity</h2>
              <p>
                Statement says: <strong>{control.supplierName ?? "—"}</strong>
                {control.accountRef && (
                  <>
                    {" "}· account <strong>{control.accountRef}</strong>
                    {control.accountName && ` (${control.accountName})`}
                  </>
                )}
                {control.dateFrom && control.dateTo && <> · covers {fmtDate(control.dateFrom)} – {fmtDate(control.dateTo)}</>}
              </p>
              <p className="mt-1">
                This import is for <strong>{supplier?.name}</strong>.{" "}
                {identityBad ? (
                  <span className="font-medium text-amber-800">The name or account number on the statement does not match this supplier. Check before importing.</span>
                ) : (
                  <span className="text-green-700">The statement matches this supplier.</span>
                )}
              </p>
            </section>
          )}

          {/* ---------- Do the statement's own totals agree with what we read? ---------- */}
          {checks.length > 0 && (
            <section className="card">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">Statement totals check</h2>
                {checksFailed ? <Pill tone="red">Does not match</Pill> : <Pill tone="green">All figures match</Pill>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-4">Figure</th>
                      <th className="py-2 pr-4 text-right">Printed on statement</th>
                      <th className="py-2 pr-4 text-right">What we read</th>
                      <th className="py-2 text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => {
                      const isMoney = c.printed.includes(".");
                      return (
                        <tr key={c.label} className="border-b border-slate-100 last:border-0">
                          <td className="py-2 pr-4">{c.label}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{isMoney ? fmtMoney(c.printed) : c.printed}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{isMoney ? fmtMoney(c.parsed) : c.parsed}</td>
                          <td className={`py-2 text-right ${c.ok ? "text-green-700" : "text-red-700"}`}>{c.ok ? "✓" : "✗ differs"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                If these agree, every line of the statement was read correctly. If not, look at the rows with errors below.
              </p>
            </section>
          )}
          {checks.length === 0 && batch.file_kind !== "pdf" && (
            <Alert kind="info">Spreadsheets do not carry control totals, so check the row counts and amounts below against the supplier&apos;s statement.</Alert>
          )}

          {(control.outside_period_count ?? 0) > 0 && (
            <Alert kind="info">
              {control.outside_period_count} rows are dated outside this period. That is normal for a running (cumulative) statement; they are still imported.
            </Alert>
          )}
          {(control.warnings ?? []).length > 0 && (
            <Alert kind="warning">Some lines could not be understood and are listed as errors: {(control.warnings ?? []).slice(0, 3).join(" | ")}</Alert>
          )}

          {/* ---------- Counts ---------- */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Rows in file", batch.total_rows, ""],
              ["Ready to import", batch.valid_rows, "text-green-700"],
              ["Errors (not imported)", batch.error_rows, batch.error_rows ? "text-red-700" : ""],
              ["Possible duplicates", batch.duplicate_rows, batch.duplicate_rows ? "text-amber-700" : ""],
            ].map(([label, n, tone]) => (
              <div key={label as string} className="card">
                <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
                <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{n}</p>
              </div>
            ))}
          </section>

          {/* ---------- Commit ---------- */}
          {staged && canEdit && (
            <section className="card space-y-3">
              <h2 className="font-semibold">Import into this period</h2>
              <p className="text-sm text-slate-700">
                <strong>{willImport}</strong> rows will be imported
                {batch.error_rows > 0 && <>; {batch.error_rows} rows with errors will not</>}
                {(undecided ?? 0) > 0 && <>; {undecided} duplicates are set to skip unless you choose otherwise</>}.
              </p>
              <form action={commitImport} className="space-y-3">
                {Object.entries(hidden).map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
                {(checksFailed || identityBad) && (
                  <label className="flex items-start gap-2 text-sm text-amber-800">
                    <input type="checkbox" name="confirm" className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                    <span>
                      I have reviewed the warnings above ({identityBad && "supplier does not match"}
                      {identityBad && checksFailed && "; "}
                      {checksFailed && "statement totals differ"}) and want to import anyway.
                    </span>
                  </label>
                )}
                <button className="btn" type="submit" disabled={willImport === 0}>
                  Import {willImport} rows
                </button>
              </form>
            </section>
          )}

          {/* ---------- Rows ---------- */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Rows</h2>
              <div className="flex flex-wrap gap-1" role="tablist">
                {FILTERS.map(([k, label]) => (
                  <Link
                    key={k}
                    href={withParams(here, { show: k })}
                    className={`rounded-md px-3 py-1.5 text-sm ${show === k ? "bg-blue-50 font-medium text-blue-800" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </div>

            {staged && canEdit && batch.duplicate_rows > 0 && show === "duplicates" && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-600">Apply to all duplicates:</span>
                {(["skip", "import"] as const).map((d) => (
                  <form key={d} action={decideAllDuplicates}>
                    {Object.entries(hidden).map(([k, v]) => (
                      <input key={k} type="hidden" name={k} value={v} />
                    ))}
                    <input type="hidden" name="decision" value={d} />
                    <button className="btn-secondary" type="submit">
                      {d === "skip" ? "Skip all" : "Import all anyway"}
                    </button>
                  </form>
                ))}
              </div>
            )}

            <div className="card overflow-x-auto p-0 sm:p-0">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-3">Row</th>
                    <th className="px-3 py-3">Result</th>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Document no.</th>
                    <th className="px-3 py-3 text-right">Debit</th>
                    <th className="px-3 py-3 text-right">Credit</th>
                    <th className="px-3 py-3">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="px-3 py-2 text-slate-500">{r.row_number}</td>
                      <td className="px-3 py-2">
                        {r.status === "valid" && <Pill tone="green">Ready</Pill>}
                        {r.status === "error" && <Pill tone="red">Error</Pill>}
                        {r.status === "duplicate" && (
                          <Pill tone="amber">{r.user_decision === "import" ? "Duplicate · import" : "Duplicate · skip"}</Pill>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{fmtDate(r.mapped.doc_date)}</td>
                      <td className="px-3 py-2">{(r.mapped.entry_type ?? "").replace("_", " ")}</td>
                      <td className="px-3 py-2 font-medium">{r.mapped.doc_number}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.mapped.debit) ? fmtMoney(r.mapped.debit) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.mapped.credit) ? fmtMoney(r.mapped.credit) : ""}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.issues.map((i, n) => (
                          <p key={n} className={i.severity === "error" ? "text-red-700" : "text-amber-800"}>
                            {i.message}
                          </p>
                        ))}
                        {staged && canEdit && r.status === "duplicate" && (
                          <form action={decideDuplicate} className="mt-1 flex gap-1">
                            {Object.entries(hidden).map(([k, v]) => (
                              <input key={k} type="hidden" name={k} value={v} />
                            ))}
                            <input type="hidden" name="row_id" value={r.id} />
                            <input type="hidden" name="show" value={show} />
                            <input type="hidden" name="page" value={page > 1 ? String(page) : ""} />
                            <button name="decision" value="skip" className="btn-secondary px-2 py-1 text-xs" type="submit">
                              Skip
                            </button>
                            <button name="decision" value="import" className="btn-secondary px-2 py-1 text-xs" type="submit">
                              Import anyway
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(rows ?? []).length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                        No rows in this view.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-between text-sm">
                {page > 1 ? (
                  <Link href={link({ page: String(page - 1) })} className="btn-secondary">
                    Previous
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-slate-600">
                  Page {page} of {pages}
                </span>
                {page < pages ? (
                  <Link href={link({ page: String(page + 1) })} className="btn-secondary">
                    Next
                  </Link>
                ) : (
                  <span />
                )}
              </div>
            )}
          </section>

          {/* ---------- After import ---------- */}
          {batch.status === "committed" && (
            <section className="card space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <strong>{batch.imported_rows}</strong> entries are in the period.
                </p>
                <Link href={`${base}/soa`} className="btn-secondary">
                  View statement entries
                </Link>
              </div>
              {isAdmin && (
                <details>
                  <summary className="cursor-pointer text-sm text-red-700">Revert this import (administrator)</summary>
                  <form action={revertImport} className="mt-3 flex flex-col gap-2 sm:flex-row">
                    {Object.entries(hidden).map(([k, v]) => (
                      <input key={k} type="hidden" name={k} value={v} />
                    ))}
                    <input name="reason" required maxLength={500} placeholder="Reason (required)" aria-label="Reason for reverting" className="input" />
                    <button className="btn-secondary whitespace-nowrap" type="submit">
                      Revert import
                    </button>
                  </form>
                  <p className="mt-1 text-xs text-slate-500">Entries are marked removed, not erased, so the history stays. The period must not be completed or locked.</p>
                </details>
              )}
            </section>
          )}
        </>
      )}

      {batch.status === "needs_mapping" && (
        <Link href={`${base}/import/${batchId}/map`} className="btn">
          Continue: match the columns
        </Link>
      )}
    </div>
  );
}
