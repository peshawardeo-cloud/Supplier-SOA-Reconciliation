import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtDate, fmtMoney } from "@/lib/format";
import { withParams } from "@/lib/forms";
import { d } from "@/lib/money";
import { Field, Pill } from "@/components/ui";
import { loadMetrics, loadResults, parseFilters, STATUS_FILTERS } from "@/lib/reports";

export const dynamic = "force-dynamic";
const SHOW = 200;

function Tile({ label, value, sub, tone, href }: { label: string; value: string; sub?: string; tone?: "red" | "green"; href?: string }) {
  const body = (
    <div className="card !p-4 h-full">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "red" ? "text-red-700" : tone === "green" ? "text-green-700" : ""}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const supabase = await createClient();

  const [{ data: suppliers }, { data: periods }, metrics, results] = await Promise.all([
    supabase.from("suppliers").select("id, code, name").is("deleted_at", null).order("code"),
    supabase.from("reconciliation_periods").select("id, supplier_id, period_start, period_end, status, supplier:suppliers(code)").order("period_end", { ascending: false }).limit(300),
    loadMetrics(supabase, f),
    loadResults(supabase, f),
  ]);

  const periodList = (periods ?? []).filter((p) => !f.supplier || p.supplier_id === f.supplier);
  const diff = metrics.internalOutstanding !== null ? d(metrics.reportedOutstanding).minus(metrics.internalOutstanding) : null;
  const keep = { supplier: f.supplier, period: f.period, status: f.status === "all" ? undefined : f.status, po: f.po || undefined, invoice: f.invoice || undefined };
  const dis = withParams("/discrepancies", { supplier: f.supplier, period: f.period });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Dashboard</h1><p className="text-sm text-slate-600">Position of the supplier reconciliations{f.supplier || f.period ? " (filtered)" : ""}</p></div>
        <a className="btn-secondary" href={withParams("/reconciliation/export", keep)}>Export results to Excel</a>
      </div>

      <form method="get" className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Field label="Supplier" htmlFor="supplier"><select id="supplier" name="supplier" defaultValue={f.supplier} className="input"><option value="">All suppliers</option>{(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Field>
        <Field label="Period" htmlFor="period"><select id="period" name="period" defaultValue={f.period} className="input"><option value="">All periods</option>{periodList.map((p) => <option key={p.id} value={p.id}>{(p.supplier as unknown as { code: string } | null)?.code} · {fmtDate(p.period_start)} – {fmtDate(p.period_end)}</option>)}</select></Field>
        <Field label="PO number" htmlFor="po"><input id="po" name="po" defaultValue={f.po} className="input" /></Field>
        <Field label="Invoice number" htmlFor="invoice"><input id="invoice" name="invoice" defaultValue={f.invoice} className="input" /></Field>
        <Field label="Status" htmlFor="status"><select id="status" name="status" defaultValue={f.status} className="input">{STATUS_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <div className="flex items-end gap-2"><button className="btn" type="submit">Apply</button><Link className="btn-secondary" href="/dashboard">Clear</Link></div>
      </form>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Suppliers" value={String(metrics.suppliers)} href="/suppliers" />
        <Tile label="Supplier-reported outstanding" value={fmtMoney(metrics.reportedOutstanding)} sub="Latest statement per supplier" />
        <Tile label="Our calculated outstanding" value={metrics.internalOutstanding !== null ? fmtMoney(metrics.internalOutstanding) : "—"} sub={metrics.internalOutstanding !== null ? `From ${metrics.periodsWithRun} reconciliation run(s)` : "Run a reconciliation first"} />
        <Tile label="Difference (supplier − ours)" value={diff ? fmtMoney(diff.toFixed(2)) : "—"} tone={diff ? (diff.abs().lte(0.05) ? "green" : "red") : undefined} />
        <Tile label="Matched invoices" value={String(metrics.invoicesMatched)} sub={`of ${metrics.invoicesTotal} invoices`} tone="green" />
        <Tile label="Unmatched invoices" value={String(metrics.invoicesUnmatched)} tone={metrics.invoicesUnmatched ? "red" : "green"} href={withParams("/dashboard", { ...keep, status: "unmatched" })} />
        <Tile label="Unmatched delivery notes" value={String(metrics.dnUnmatched)} href={f.supplier ? `/suppliers/${f.supplier}/documents/dn` : undefined} />
        <Tile label="PO / invoice discrepancies" value={String(metrics.poInvoiceDiscrepancies)} href={dis} />
        <Tile label="Pending credit notes" value={String(metrics.creditNotesPending)} sub={metrics.creditNotesPending ? `${fmtMoney(metrics.creditNotesPendingAmount)} not yet applied` : undefined} />
        <Tile label="Pending refunds" value={fmtMoney(metrics.refundsPending)} sub={`${metrics.refundsPendingCount} open claim(s)`} href={withParams("/refunds", { supplier: f.supplier })} />
        <Tile label="Open discrepancies" value={String(metrics.openDiscrepancies)} tone={metrics.openDiscrepancies ? "red" : "green"} href={dis} />
        <Tile label="Reconciliation completion" value={`${metrics.completionPct}%`} sub={`${metrics.periodsDone} of ${metrics.periodsTotal} periods completed`} />
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Reconciliation results <span className="text-sm font-normal text-slate-500">({results.length} document{results.length === 1 ? "" : "s"})</span></h2>
        <div className="card overflow-x-auto p-0 sm:p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Supplier</th><th className="px-3 py-2">Document</th><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">Our amount</th><th className="px-3 py-2">Statement</th><th className="px-3 py-2 text-right">Difference</th><th className="px-3 py-2">PO</th><th className="px-3 py-2">Result</th><th className="px-3 py-2 text-right">Issues</th></tr></thead>
            <tbody>
              {results.slice(0, SHOW).map((r) => (
                <tr key={r.invoiceId} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-1.5">{r.supplierCode}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-medium">{r.invoiceNumber}{r.docType === "credit_note" && <span className="text-amber-700"> (CN)</span>}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(r.invoiceDate)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.gross)}</td>
                  <td className="px-3 py-1.5">{r.soaDoc}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.difference && Math.abs(Number(r.difference)) > 0.05 ? "font-medium text-red-700" : ""}`}>{r.difference !== null ? fmtMoney(r.difference) : ""}</td>
                  <td className="px-3 py-1.5">{r.linkedPo || r.poRefs}</td>
                  <td className="px-3 py-1.5"><Pill tone={r.matchState === "matched" ? "green" : r.matchState === "suggested" ? "amber" : "red"}>{r.matchState === "matched" ? "Matched" : r.matchState === "suggested" ? "To confirm" : "Not on statement"}</Pill></td>
                  <td className="px-3 py-1.5 text-right">{r.openDiscrepancies || ""}</td>
                </tr>
              ))}
              {results.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">No documents match. Import invoices and run a reconciliation, or change the filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {results.length > SHOW && <p className="text-xs text-slate-500">Showing the first {SHOW}. The Excel export contains all {results.length}.</p>}
      </section>
    </div>
  );
}
