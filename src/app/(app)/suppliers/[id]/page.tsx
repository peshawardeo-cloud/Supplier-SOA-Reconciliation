import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { fmtDate, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, Field, PeriodStatusPill, Pill } from "@/components/ui";
import type { Period, Supplier } from "@/lib/types";
import { addAlias, createPeriod } from "../actions";

const SAVED: Record<string, string> = {
  created: "Supplier created. Add a reconciliation period to start importing statements.",
  updated: "Supplier updated.",
  alias: "Name added.",
};

export default async function SupplierWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  if (!isUuid(id)) notFound();

  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";

  const supabase = await createClient();
  const { data: supplier } = await supabase
    .from("suppliers")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<Supplier>();
  if (!supplier) notFound();

  const [{ data: periods }, { data: aliases }] = await Promise.all([
    supabase
      .from("reconciliation_periods")
      .select("*")
      .eq("supplier_id", id)
      .order("period_end", { ascending: false })
      .returns<Period[]>(),
    supabase.from("supplier_aliases").select("id, alias_name").eq("supplier_id", id).order("alias_name"),
  ]);

  const details: [string, string | null][] = [
    ["VAT number", supplier.vat_number],
    ["CR number", supplier.cr_number],
    ["Our account no.", supplier.account_ref],
    ["Currency", supplier.currency],
    ["Payment terms", supplier.payment_terms_days !== null ? `Net ${supplier.payment_terms_days} days` : null],
    ["Contact", supplier.contact_name],
    ["Email", supplier.email],
    ["Phone", supplier.phone],
    ["Address", supplier.address],
  ];

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { label: supplier.code }]} />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">
            {supplier.name} {!supplier.is_active && <Pill>Inactive</Pill>}
          </h1>
          <p className="text-sm text-slate-600">Supplier workspace · {supplier.code}</p>
        </div>
        {canEdit && (
          <Link href={`/suppliers/${id}/edit`} className="btn-secondary">
            Edit supplier
          </Link>
        )}
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {saved && SAVED[saved] && <Alert kind="success">{SAVED[saved]}</Alert>}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Details</h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {details.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd>{v || <span className="text-slate-400">—</span>}</dd>
              </div>
            ))}
          </dl>
          {supplier.notes && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{supplier.notes}</p>}
        </section>

        <section className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Other names</h2>
          <ul className="mb-3 space-y-1 text-sm">
            {(aliases ?? []).map((a) => (
              <li key={a.id}>{a.alias_name}</li>
            ))}
            {(aliases ?? []).length === 0 && <li className="text-slate-400">None</li>}
          </ul>
          {canEdit && (
            <form action={addAlias} className="flex gap-2">
              <input type="hidden" name="supplier_id" value={id} />
              <input name="alias_name" aria-label="Alternative name" placeholder="Name on statements" maxLength={200} className="input" />
              <button className="btn-secondary" type="submit">
                Add
              </button>
            </form>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Documents</h2>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className="btn-secondary" href={`/suppliers/${id}/documents/invoice`}>Invoices</Link>
          <Link className="btn-secondary" href={`/suppliers/${id}/documents/po`}>Purchase orders</Link>
          <Link className="btn-secondary" href={`/suppliers/${id}/documents/dn`}>Delivery notes</Link>
          <Link className="btn-secondary" href={`/suppliers/${id}/documents/payment`}>Payments</Link>
          <Link className="btn-secondary" href={`/suppliers/${id}/allocations`}>Apply payments</Link>
          <Link className="btn-secondary" href={`/discrepancies?supplier=${id}`}>Discrepancies</Link>
          <Link className="btn-secondary" href={`/refunds?supplier=${id}`}>Refund claims</Link>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Reconciliation periods</h2>
        </div>

        {canEdit && (
          <details className="card" open={(periods ?? []).length === 0}>
            <summary className="cursor-pointer text-sm font-medium text-blue-700">New reconciliation period</summary>
            <form action={createPeriod} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <input type="hidden" name="supplier_id" value={id} />
              <Field label="Period start" htmlFor="period_start">
                <input id="period_start" name="period_start" type="date" required className="input" />
              </Field>
              <Field label="Period end" htmlFor="period_end">
                <input id="period_end" name="period_end" type="date" required className="input" />
              </Field>
              <Field label="Statement date" htmlFor="statement_date" hint="Optional">
                <input id="statement_date" name="statement_date" type="date" className="input" />
              </Field>
              <Field label="Supplier-reported opening balance" htmlFor="reported_opening_balance" hint="Optional. Leave empty if the statement starts at zero.">
                <input id="reported_opening_balance" name="reported_opening_balance" inputMode="decimal" className="input" />
              </Field>
              <Field label="Supplier-reported closing balance" htmlFor="reported_closing_balance" hint="Optional. Filled automatically from a statement import.">
                <input id="reported_closing_balance" name="reported_closing_balance" inputMode="decimal" className="input" />
              </Field>
              <Field label="Notes" htmlFor="notes">
                <input id="notes" name="notes" maxLength={2000} className="input" />
              </Field>
              <div className="sm:col-span-2 lg:col-span-3">
                <button className="btn" type="submit">
                  Create period
                </button>
              </div>
            </form>
          </details>
        )}

        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3">Statement date</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Reported closing</th>
              </tr>
            </thead>
            <tbody>
              {(periods ?? []).map((p) => (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/suppliers/${id}/periods/${p.id}`} className="font-medium text-blue-700 hover:underline">
                      {fmtDate(p.period_start)} – {fmtDate(p.period_end)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{fmtDate(p.statement_date)}</td>
                  <td className="px-4 py-3">
                    <PeriodStatusPill status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(p.reported_closing_balance)}</td>
                </tr>
              ))}
              {(periods ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    No periods yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
