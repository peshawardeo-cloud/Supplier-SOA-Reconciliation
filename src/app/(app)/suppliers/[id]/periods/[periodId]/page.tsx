import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { d } from "@/lib/money";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, Field, ImportStatusPill, PeriodStatusPill } from "@/components/ui";
import {
  OPEN_PERIOD_STATUSES,
  PERIOD_STATUSES,
  PERIOD_STATUS_LABEL,
  type ImportBatch,
  type Period,
  type Supplier,
} from "@/lib/types";
import { updatePeriodDetails, updatePeriodStatus } from "../../../actions";

const SAVED: Record<string, string> = {
  status: "Status updated.",
  details: "Period details saved.",
};

const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoices",
  credit_note: "Credit notes",
  debit_note: "Debit notes",
  payment: "Payments",
  opening_balance: "Opening balance",
  adjustment: "Adjustments",
  other: "Other",
};

type SummaryRow = { entry_type: string; entries: number; debit: string; credit: string };

export default async function PeriodPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; periodId: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id, periodId } = await params;
  const { error, saved } = await searchParams;
  if (!isUuid(id) || !isUuid(periodId)) notFound();

  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const isAdmin = profile?.role === "admin";

  const supabase = await createClient();
  const [{ data: supplier }, { data: period }] = await Promise.all([
    supabase.from("suppliers").select("*").eq("id", id).maybeSingle<Supplier>(),
    supabase.from("reconciliation_periods").select("*").eq("id", periodId).eq("supplier_id", id).maybeSingle<Period>(),
  ]);
  if (!supplier || !period) notFound();

  const [{ data: summary }, { data: batches }] = await Promise.all([
    supabase.rpc("soa_period_summary", { p_period_id: periodId }),
    supabase
      .from("import_batches")
      .select("*")
      .eq("period_id", periodId)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<ImportBatch[]>(),
  ]);

  const rows = (summary ?? []) as SummaryRow[];
  const totalDebit = rows.reduce((a, r) => a.plus(r.debit), d(0));
  const totalCredit = rows.reduce((a, r) => a.plus(r.credit), d(0));
  const opening = d(period.reported_opening_balance ?? 0);
  const calculatedClosing = opening.plus(totalDebit).minus(totalCredit);
  const hasEntries = rows.length > 0;
  const reportedClosing = period.reported_closing_balance;
  const difference = reportedClosing !== null ? d(reportedClosing).minus(calculatedClosing) : null;
  const open = OPEN_PERIOD_STATUSES.includes(period.status);
  const base = `/suppliers/${id}/periods/${periodId}`;

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { href: "/suppliers", label: "Suppliers" },
          { href: `/suppliers/${id}`, label: supplier.code },
          { label: `${fmtDate(period.period_start)} – ${fmtDate(period.period_end)}` },
        ]}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">
            {supplier.name} <span className="text-slate-400">·</span> {fmtDate(period.period_start)} – {fmtDate(period.period_end)}
          </h1>
          <p className="text-sm text-slate-600">Reconciliation period</p>
        </div>
        <PeriodStatusPill status={period.status} />
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {saved && SAVED[saved] && <Alert kind="success">{SAVED[saved]}</Alert>}

      {/* ---------- Statement figures and how the difference is calculated ---------- */}
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Supplier statement (imported)</h2>
          {hasEntries && (
            <Link href={`${base}/soa`} className="text-sm text-blue-700 hover:underline">
              View all statement entries
            </Link>
          )}
        </div>

        {hasEntries ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-4">Entry type</th>
                    <th className="py-2 pr-4 text-right">Entries</th>
                    <th className="py-2 pr-4 text-right">Debit (we owe more)</th>
                    <th className="py-2 text-right">Credit (we owe less)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.entry_type} className="border-b border-slate-100">
                      <td className="py-2 pr-4">{TYPE_LABEL[r.entry_type] ?? r.entry_type}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.entries}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmtMoney(r.debit)}</td>
                      <td className="py-2 text-right tabular-nums">{fmtMoney(r.credit)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-2 pr-4">Total</td>
                    <td />
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtMoney(totalDebit.toFixed(2))}</td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(totalCredit.toFixed(2))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <p className="mb-2 font-medium">How the closing balance is calculated</p>
              <dl className="space-y-1 tabular-nums">
                <div className="flex justify-between gap-4">
                  <dt>Supplier-reported opening balance</dt>
                  <dd>{fmtMoney(opening.toFixed(2))}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>+ Debits</dt>
                  <dd>{fmtMoney(totalDebit.toFixed(2))}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>− Credits</dt>
                  <dd>{fmtMoney(totalCredit.toFixed(2))}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-slate-300 pt-1 font-medium">
                  <dt>= Closing balance from the imported entries</dt>
                  <dd>{fmtMoney(calculatedClosing.toFixed(2))}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Supplier-reported closing balance</dt>
                  <dd>{reportedClosing !== null ? fmtMoney(reportedClosing) : "not entered"}</dd>
                </div>
                {difference && (
                  <div className={`flex justify-between gap-4 font-medium ${difference.isZero() ? "text-green-700" : "text-red-700"}`}>
                    <dt>Difference (reported − calculated)</dt>
                    <dd>{fmtMoney(difference.toFixed(2))}</dd>
                  </div>
                )}
              </dl>
              <p className="mt-2 text-xs text-slate-500">
                Positive balance = we owe the supplier. These figures come from the supplier&apos;s statement only; comparison with our own POs, delivery notes and invoices comes in a later phase.
              </p>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500">No statement has been imported for this period yet.</p>
        )}
      </section>

      <section className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Reconcile with our records</h2>
          <p className="text-sm text-slate-600">Compare this statement with your invoices, payments, purchase orders and delivery notes.</p>
        </div>
        <Link href={`${base}/reconcile`} className="btn">Open reconciliation</Link>
      </section>

      {/* ---------- Imports ---------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Imports</h2>
          {canEdit &&
            (open ? (
              <Link href={`${base}/import/soa`} className="btn">
                Import supplier statement (SOA)
              </Link>
            ) : (
              <p className="text-sm text-slate-500">Imports are closed because the period is {PERIOD_STATUS_LABEL[period.status].toLowerCase()}.</p>
            ))}
        </div>
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Rows</th>
                <th className="px-4 py-3 text-right">Imported</th>
              </tr>
            </thead>
            <tbody>
              {(batches ?? []).map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={b.status === "needs_mapping" ? `${base}/import/${b.id}/map` : `${base}/import/${b.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {b.file_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDateTime(b.created_at)}</td>
                  <td className="px-4 py-3">
                    <ImportStatusPill status={b.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{b.total_rows}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{b.imported_rows}</td>
                </tr>
              ))}
              {(batches ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No imports yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------- Status and details ---------- */}
      {canEdit && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Status</h2>
            <form action={updatePeriodStatus} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="supplier_id" value={id} />
              <input type="hidden" name="period_id" value={periodId} />
              <Field label="Change status to" htmlFor="status" className="flex-1">
                <select id="status" name="status" defaultValue={period.status} className="input">
                  {PERIOD_STATUSES.filter((s) => s !== "locked" || isAdmin || period.status === "locked").map((s) => (
                    <option key={s} value={s}>
                      {PERIOD_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="btn" type="submit">
                Update
              </button>
            </form>
            <p className="mt-2 text-xs text-slate-500">
              Only draft and in-progress periods accept imports. Only an administrator can lock or unlock a period.
            </p>
          </section>

          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Period details</h2>
            <form action={updatePeriodDetails} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="supplier_id" value={id} />
              <input type="hidden" name="period_id" value={periodId} />
              <Field label="Period start" htmlFor="d_start">
                <input id="d_start" name="period_start" type="date" required defaultValue={period.period_start} className="input" />
              </Field>
              <Field label="Period end" htmlFor="d_end">
                <input id="d_end" name="period_end" type="date" required defaultValue={period.period_end} className="input" />
              </Field>
              <Field label="Statement date" htmlFor="d_stmt">
                <input id="d_stmt" name="statement_date" type="date" defaultValue={period.statement_date ?? ""} className="input" />
              </Field>
              <Field label="Reported opening balance" htmlFor="d_open">
                <input id="d_open" name="reported_opening_balance" inputMode="decimal" defaultValue={period.reported_opening_balance ?? ""} className="input" />
              </Field>
              <Field label="Reported closing balance" htmlFor="d_close">
                <input id="d_close" name="reported_closing_balance" inputMode="decimal" defaultValue={period.reported_closing_balance ?? ""} className="input" />
              </Field>
              <Field label="Notes" htmlFor="d_notes">
                <input id="d_notes" name="notes" maxLength={2000} defaultValue={period.notes ?? ""} className="input" />
              </Field>
              <div className="sm:col-span-2">
                <button className="btn-secondary" type="submit">
                  Save details
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
