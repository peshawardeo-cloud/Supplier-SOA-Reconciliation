import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid, safeSearch, withParams } from "@/lib/forms";
import { fmtDate, fmtMoney } from "@/lib/format";
import { Breadcrumbs } from "@/components/ui";

const PAGE_SIZE = 50;

const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  debit_note: "Debit note",
  payment: "Payment",
  opening_balance: "Opening balance",
  adjustment: "Adjustment",
  other: "Other",
};

type Entry = {
  id: string;
  entry_type: string;
  doc_number: string;
  doc_date: string;
  delivery_ref: string | null;
  description: string | null;
  debit: string;
  credit: string;
  source_row: number;
  batch_id: string;
};

export default async function SoaEntriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; periodId: string }>;
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}) {
  const { id, periodId } = await params;
  const sp = await searchParams;
  if (!isUuid(id) || !isUuid(periodId)) notFound();

  const q = safeSearch(sp.q);
  const type = sp.type && TYPE_LABEL[sp.type] ? sp.type : "";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();
  const [{ data: supplier }, { data: period }] = await Promise.all([
    supabase.from("suppliers").select("id, code, name").eq("id", id).maybeSingle(),
    supabase.from("reconciliation_periods").select("id, period_start, period_end").eq("id", periodId).eq("supplier_id", id).maybeSingle(),
  ]);
  if (!supplier || !period) notFound();

  let query = supabase
    .from("soa_entries")
    .select("id, entry_type, doc_number, doc_date, delivery_ref, description, debit, credit, source_row, batch_id", { count: "exact" })
    .eq("period_id", periodId)
    .is("deleted_at", null)
    .order("doc_date", { ascending: true })
    .order("source_row", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (type) query = query.eq("entry_type", type);
  if (q) query = query.or(`doc_number.ilike.%${q}%,delivery_ref.ilike.%${q}%,po_ref.ilike.%${q}%,description.ilike.%${q}%`);
  const { data, count } = await query.returns<Entry[]>();

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const base = `/suppliers/${id}/periods/${periodId}/soa`;
  const link = (p: number) => withParams(base, { q: q || undefined, type: type || undefined, page: p > 1 ? String(p) : undefined });

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          { href: "/suppliers", label: "Suppliers" },
          { href: `/suppliers/${id}`, label: supplier.code },
          { href: `/suppliers/${id}/periods/${periodId}`, label: `${fmtDate(period.period_start)} – ${fmtDate(period.period_end)}` },
          { label: "Statement entries" },
        ]}
      />
      <h1 className="text-xl font-semibold">Statement entries</h1>

      <form className="card flex flex-col gap-3 sm:flex-row sm:items-end" role="search">
        <div className="flex-1">
          <label htmlFor="q" className="label">
            Search document, delivery, PO or description
          </label>
          <input id="q" name="q" defaultValue={q} className="input" />
        </div>
        <div>
          <label htmlFor="type" className="label">
            Type
          </label>
          <select id="type" name="type" defaultValue={type} className="input">
            <option value="">All</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-secondary" type="submit">
          Filter
        </button>
      </form>

      <p className="text-sm text-slate-600">{total} entries</p>

      <div className="card overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Document no.</th>
              <th className="px-4 py-3">Delivery no.</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3 text-right">Debit</th>
              <th className="px-4 py-3 text-right">Credit</th>
              <th className="px-4 py-3 text-right">Source row</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((e) => (
              <tr key={e.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-4 py-2">{fmtDate(e.doc_date)}</td>
                <td className="px-4 py-2">{TYPE_LABEL[e.entry_type] ?? e.entry_type}</td>
                <td className="px-4 py-2 font-medium">{e.doc_number}</td>
                <td className="px-4 py-2">{e.delivery_ref}</td>
                <td className="max-w-xs truncate px-4 py-2" title={e.description ?? ""}>
                  {e.description}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(e.debit) ? fmtMoney(e.debit) : ""}</td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(e.credit) ? fmtMoney(e.credit) : ""}</td>
                <td className="px-4 py-2 text-right text-slate-500">
                  <Link href={`/suppliers/${id}/periods/${periodId}/import/${e.batch_id}`} className="hover:underline">
                    #{e.source_row}
                  </Link>
                </td>
              </tr>
            ))}
            {(data ?? []).length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  No entries found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={link(page - 1)} className="btn-secondary">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-slate-600">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={link(page + 1)} className="btn-secondary">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
