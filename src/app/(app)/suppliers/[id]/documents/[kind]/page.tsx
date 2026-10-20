import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid, safeSearch, withParams } from "@/lib/forms";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, ImportStatusPill, Pill } from "@/components/ui";
import { DOC_KINDS, DOC_KIND_LABEL, type DocKind } from "@/lib/import/doc-types";
import type { ImportBatch } from "@/lib/types";
import { commitAllClean } from "../actions";

const PAGE = 100;
type Row = Record<string, string | number | null>;

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; kind: string }>;
  searchParams: Promise<{ q?: string; page?: string; error?: string; notice?: string }>;
}) {
  const { id, kind } = await params;
  const sp = await searchParams;
  if (!isUuid(id) || !(DOC_KINDS as string[]).includes(kind)) notFound();
  const k = kind as DocKind;
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";

  const supabase = await createClient();
  const { data: supplier } = await supabase.from("suppliers").select("id, code, name").eq("id", id).maybeSingle();
  if (!supplier) notFound();

  const q = safeSearch(sp.q);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE;

  const cfg = {
    po: { table: "po_headers", num: "po_number", date: "po_date", cols: "id, po_number, po_date, project_ref, net_amount, gross_amount" },
    dn: { table: "dn_headers", num: "dn_number", date: "dn_date", cols: "id, dn_number, dn_date, po_refs, project_ref, received_by" },
    invoice: { table: "invoices", num: "invoice_number", date: "invoice_date", cols: "id, invoice_number, doc_type, invoice_date, po_refs, net_amount, vat_amount, gross_amount, vat_calculated" },
    payment: { table: "payments", num: "payment_ref", date: "payment_date", cols: "id, payment_ref, payment_date, amount, method, bank_ref, source" },
  }[k];

  let query = supabase.from(cfg.table).select(cfg.cols, { count: "exact" }).eq("supplier_id", id).is("deleted_at", null).order(cfg.date, { ascending: false }).range(from, from + PAGE - 1);
  if (q) query = query.ilike(cfg.num, `%${q}%`);

  const [{ data: rows, count }, { data: batches }, balances] = await Promise.all([
    query.returns<Row[]>(),
    supabase.from("import_batches").select("*").eq("supplier_id", id).eq("import_type", k).order("created_at", { ascending: false }).limit(15).returns<ImportBatch[]>(),
    k === "invoice"
      ? supabase.rpc("invoice_balances", { p_supplier_id: id })
      : k === "payment"
        ? supabase.rpc("payment_balances", { p_supplier_id: id })
        : Promise.resolve({ data: null }),
  ]);

  const bal = new Map<string, Row>();
  for (const b of (balances.data ?? []) as Row[]) bal.set(String(b.invoice_id ?? b.payment_id), b);

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const readyClean = (batches ?? []).filter((b) => b.status === "staged" && b.error_rows === 0 && b.valid_rows > 0).length;
  const here = `/suppliers/${id}/documents/${k}`;

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { href: `/suppliers/${id}`, label: supplier.code }, { label: DOC_KIND_LABEL[k] }]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{DOC_KIND_LABEL[k]}</h1>
          <p className="text-sm text-slate-600">{supplier.name} · {total} on file</p>
        </div>
        {canEdit && <Link className="btn" href={`${here}/import`}>Import {DOC_KIND_LABEL[k].toLowerCase()}</Link>}
      </div>

      {sp.notice && <Alert kind="success">{sp.notice}</Alert>}
      {sp.error && <Alert kind="error">{sp.error}</Alert>}

      <nav className="flex flex-wrap gap-2 text-sm">
        {DOC_KINDS.map((x) => (
          <Link key={x} href={`/suppliers/${id}/documents/${x}`} className={x === k ? "font-semibold text-blue-800 underline" : "text-slate-600 hover:underline"}>
            {DOC_KIND_LABEL[x]}
          </Link>
        ))}
      </nav>

      {(batches ?? []).length > 0 && (
        <section className="card space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Recent imports</h2>
            {canEdit && readyClean > 0 && (
              <form action={commitAllClean}>
                <input type="hidden" name="supplier_id" value={id} />
                <input type="hidden" name="kind" value={k} />
                <button className="btn-secondary" type="submit">Import all {readyClean} clean file(s)</button>
              </form>
            )}
          </div>
          <ul className="divide-y divide-slate-100 text-sm">
            {(batches ?? []).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link className="break-all text-blue-800 hover:underline" href={b.status === "needs_mapping" ? `/suppliers/${id}/documents/import/${b.id}/map` : `/suppliers/${id}/documents/import/${b.id}`}>{b.file_name}</Link>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {b.status === "staged" && <>{b.valid_rows} ready · {b.error_rows} errors · {b.duplicate_rows} duplicates</>}
                  {fmtDateTime(b.created_at)}
                  <ImportStatusPill status={b.status} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form method="get" className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Search by number" className="input max-w-xs" />
        <button className="btn-secondary" type="submit">Search</button>
      </form>

      <div className="card overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-3 py-2">Number</th>
              <th className="px-3 py-2">Date</th>
              {k === "po" && <><th className="px-3 py-2">Project</th><th className="px-3 py-2 text-right">Net</th><th className="px-3 py-2 text-right">Gross</th></>}
              {k === "dn" && <><th className="px-3 py-2">PO</th><th className="px-3 py-2">Project</th><th className="px-3 py-2">Received by</th></>}
              {k === "invoice" && <><th className="px-3 py-2">Type</th><th className="px-3 py-2">PO</th><th className="px-3 py-2 text-right">Net</th><th className="px-3 py-2 text-right">VAT</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2 text-right">Open</th></>}
              {k === "payment" && <><th className="px-3 py-2">Method</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Not applied</th><th className="px-3 py-2">Source</th></>}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => {
              const b = bal.get(String(r.id));
              return (
                <tr key={String(r.id)} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5 font-medium">{r[cfg.num]}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(String(r[cfg.date]))}</td>
                  {k === "po" && <><td className="px-3 py-1.5">{r.project_ref}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.net_amount)}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.gross_amount)}</td></>}
                  {k === "dn" && <><td className="px-3 py-1.5">{(r.po_refs as unknown as string[] | null)?.join(", ")}</td><td className="px-3 py-1.5">{r.project_ref}</td><td className="px-3 py-1.5">{r.received_by}</td></>}
                  {k === "invoice" && (
                    <>
                      <td className="px-3 py-1.5">{r.doc_type === "credit_note" ? <Pill tone="amber">Credit note</Pill> : "Invoice"}</td>
                      <td className="px-3 py-1.5">{(r.po_refs as unknown as string[] | null)?.join(", ")}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.net_amount)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.vat_amount)}{r.vat_calculated ? <span title="VAT was calculated, not read from the file" className="text-amber-700"> *</span> : null}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.gross_amount)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{b ? fmtMoney(b.open_amount) : ""}</td>
                    </>
                  )}
                  {k === "payment" && (
                    <>
                      <td className="px-3 py-1.5">{r.method}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.amount)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{b ? fmtMoney(b.unallocated) : ""}</td>
                      <td className="px-3 py-1.5">{r.source === "manual" ? "Typed in" : "Imported"}</td>
                    </>
                  )}
                </tr>
              );
            })}
            {(rows ?? []).length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">Nothing here yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {k === "invoice" && <p className="text-xs text-slate-500">* VAT was not in the file and was calculated at the configured rate. &quot;Open&quot; is the invoice minus payments and credit notes applied.</p>}
      {pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 && <Link className="btn-secondary" href={withParams(here, { q, page: String(page - 1) })}>Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link className="btn-secondary" href={withParams(here, { q, page: String(page + 1) })}>Next</Link>}
        </div>
      )}
    </div>
  );
}
