import Link from "next/link";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { safeSearch } from "@/lib/forms";
import { Pill } from "@/components/ui";
import type { Supplier } from "@/lib/types";

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; all?: string }>;
}) {
  const { q: rawQ, all } = await searchParams;
  const q = safeSearch(rawQ);
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";

  const supabase = await createClient();
  let query = supabase.from("suppliers").select("*").is("deleted_at", null).order("name").limit(500);
  if (all !== "1") query = query.eq("is_active", true);
  if (q) query = query.or(`name.ilike.%${q}%,code.ilike.%${q}%,vat_number.ilike.%${q}%,account_ref.ilike.%${q}%`);
  const { data: suppliers, error } = await query.returns<Supplier[]>();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Suppliers</h1>
          <p className="text-sm text-slate-600">Each supplier has its own workspace for statements and reconciliation periods.</p>
        </div>
        {canEdit && (
          <Link href="/suppliers/new" className="btn">
            Add supplier
          </Link>
        )}
      </div>

      <form className="card flex flex-col gap-3 sm:flex-row sm:items-end" role="search">
        <div className="flex-1">
          <label htmlFor="q" className="label">
            Search by name, code, VAT or account number
          </label>
          <input id="q" name="q" defaultValue={q} className="input" placeholder="e.g. SAVETO" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="all" value="1" defaultChecked={all === "1"} className="h-4 w-4 rounded border-slate-300" />
          Include inactive
        </label>
        <button className="btn-secondary" type="submit">
          Search
        </button>
      </form>

      {error && <p className="text-sm text-red-700">Suppliers could not be loaded. Check that migration 0002 was run.</p>}

      <div className="card overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">VAT number</th>
              <th className="px-4 py-3">Account no.</th>
              <th className="px-4 py-3">Terms</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(suppliers ?? []).map((s) => (
              <tr key={s.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/suppliers/${s.id}`} className="text-blue-700 hover:underline">
                    {s.code}
                  </Link>
                </td>
                <td className="px-4 py-3">{s.name}</td>
                <td className="px-4 py-3">{s.vat_number}</td>
                <td className="px-4 py-3">{s.account_ref}</td>
                <td className="px-4 py-3">{s.payment_terms_days !== null ? `Net ${s.payment_terms_days}` : ""}</td>
                <td className="px-4 py-3">{s.is_active ? <Pill tone="green">Active</Pill> : <Pill>Inactive</Pill>}</td>
              </tr>
            ))}
            {(suppliers ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  {q ? "No suppliers match your search." : "No suppliers yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
