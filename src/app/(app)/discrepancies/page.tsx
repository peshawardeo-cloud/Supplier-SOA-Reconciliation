import Link from "next/link";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid, safeSearch, withParams } from "@/lib/forms";
import { fmtDate, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, Field, Pill } from "@/components/ui";
import { ACTIVE_STATUSES, DISCREPANCY_STATUSES, STATUS_LABEL, STATUS_TONE, TYPE_LABEL, typeLabel, type DiscrepancyStatus } from "@/lib/discrepancy";
import { createManualDiscrepancy } from "./actions";

const PAGE = 100;
type Row = {
  id: string; type: string; status: DiscrepancyStatus; ref_text: string | null; expected_amount: string | null; actual_amount: string | null; difference: string | null;
  explanation: string; created_at: string; source: string; supplier: { code: string; name: string } | null; assignee: { full_name: string | null; email: string | null } | null;
};

export default async function DiscrepanciesPage({
  searchParams,
}: {
  searchParams: Promise<{ supplier?: string; period?: string; status?: string; type?: string; q?: string; page?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const supabase = await createClient();

  const supplier = isUuid(sp.supplier ?? "") ? sp.supplier! : "";
  const period = isUuid(sp.period ?? "") ? sp.period! : "";
  const status = sp.status === "active" || (DISCREPANCY_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status! : "active";
  const type = sp.type && TYPE_LABEL[sp.type] ? sp.type : "";
  const q = safeSearch(sp.q);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE;

  let query = supabase
    .from("discrepancies")
    .select("id, type, status, ref_text, expected_amount, actual_amount, difference, explanation, created_at, source, supplier:suppliers(code, name), assignee:profiles!discrepancies_assigned_to_fkey(full_name, email)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE - 1);
  if (supplier) query = query.eq("supplier_id", supplier);
  if (period) query = query.eq("period_id", period);
  if (type) query = query.eq("type", type);
  if (status === "active") query = query.in("status", ACTIVE_STATUSES);
  else if (status !== "all") query = query.eq("status", status);
  if (q) query = query.or(`ref_text.ilike.%${q}%,explanation.ilike.%${q}%`);

  const [{ data: rows, count }, { data: suppliers }] = await Promise.all([
    query.returns<Row[]>(),
    supabase.from("suppliers").select("id, code, name").is("deleted_at", null).order("code"),
  ]);
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const keep = { supplier, period, status, type, q };
  const exportHref = withParams("/discrepancies/export", keep);

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ label: "Discrepancies" }]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Discrepancies</h1><p className="text-sm text-slate-600">{total} item(s) match the filters</p></div>
        <a className="btn-secondary" href={exportHref}>Export to Excel</a>
      </div>
      {sp.error && <Alert kind="error">{sp.error}</Alert>}

      <form method="get" className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Supplier" htmlFor="supplier"><select id="supplier" name="supplier" defaultValue={supplier} className="input"><option value="">All suppliers</option>{(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Field>
        <Field label="Status" htmlFor="status"><select id="status" name="status" defaultValue={status} className="input"><option value="active">Not yet resolved</option><option value="all">All</option>{DISCREPANCY_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></Field>
        <Field label="Type" htmlFor="type"><select id="type" name="type" defaultValue={type} className="input"><option value="">All types</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Search (invoice, PO, text)" htmlFor="q"><input id="q" name="q" defaultValue={q} className="input" /></Field>
        <input type="hidden" name="period" value={period} />
        <div className="flex items-end"><button className="btn" type="submit">Filter</button></div>
      </form>

      <div className="card overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[860px] text-sm">
          <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Supplier</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2 text-right">Expected</th><th className="px-3 py-2 text-right">Actual</th><th className="px-3 py-2 text-right">Difference</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Assigned</th></tr></thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50">
                <td className="px-3 py-2">{r.supplier?.code}</td>
                <td className="px-3 py-2"><Link className="text-blue-700 hover:underline" href={`/discrepancies/${r.id}`}>{typeLabel(r.type)}</Link><div className="text-xs text-slate-500">{fmtDate(r.created_at)}{r.source === "manual" && " · manual"}</div></td>
                <td className="px-3 py-2">{r.ref_text}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.expected_amount !== null ? fmtMoney(r.expected_amount) : ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.actual_amount !== null ? fmtMoney(r.actual_amount) : ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.expected_amount !== null || r.actual_amount !== null ? fmtMoney(r.difference) : ""}</td>
                <td className="px-3 py-2"><Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill></td>
                <td className="px-3 py-2 text-xs">{r.assignee?.full_name ?? r.assignee?.email ?? ""}</td>
              </tr>
            ))}
            {(rows ?? []).length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500">Nothing to show. Run a reconciliation from a period, or change the filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 && <Link className="btn-secondary" href={withParams("/discrepancies", { ...keep, page: String(page - 1) })}>Previous</Link>}
          <span>Page {page} of {pages}</span>
          {page < pages && <Link className="btn-secondary" href={withParams("/discrepancies", { ...keep, page: String(page + 1) })}>Next</Link>}
        </div>
      )}

      {canEdit && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-blue-700">Add a discrepancy by hand</summary>
          <form action={createManualDiscrepancy} className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Supplier *" htmlFor="m_supplier"><select id="m_supplier" name="supplier_id" required defaultValue={supplier} className="input"><option value="" disabled>Choose…</option>{(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Field>
            <Field label="Reference (invoice, PO…)" htmlFor="ref_text"><input id="ref_text" name="ref_text" className="input" /></Field>
            <Field label="Expected amount" htmlFor="expected_amount"><input id="expected_amount" name="expected_amount" inputMode="decimal" className="input" /></Field>
            <Field label="Actual amount" htmlFor="actual_amount"><input id="actual_amount" name="actual_amount" inputMode="decimal" className="input" /></Field>
            <Field label="What is wrong? *" htmlFor="explanation" className="sm:col-span-2"><textarea id="explanation" name="explanation" required rows={3} className="input" /></Field>
            <input type="hidden" name="period_id" value={period} />
            <div className="sm:col-span-2"><button className="btn" type="submit">Add discrepancy</button></div>
          </form>
        </details>
      )}
    </div>
  );
}
