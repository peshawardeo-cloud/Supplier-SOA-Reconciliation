import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/reconcile/load";
import { isUuid } from "@/lib/forms";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, Pill } from "@/components/ui";
import type { Waterfall, Evidence } from "@/lib/reconcile/engine";
import { decideMatch, manualLink, manualMatch, runReconciliation } from "./actions";

type M = {
  id: string; soa_entry_id: string; invoice_id: string | null; payment_id: string | null;
  origin: "exact" | "suggested" | "manual"; state: string; confidence: number; evidence: Evidence[]; reject_reason: string | null;
  soa: { doc_number: string; doc_date: string; entry_type: string; debit: string; credit: string } | null;
  inv: { invoice_number: string; gross_amount: string; invoice_date: string; doc_type: string } | null;
  pay: { payment_ref: string; amount: string; payment_date: string } | null;
};
type L = {
  id: string; invoice_id: string; po_id: string | null; dn_id: string | null; origin: string; state: string; confidence: number; evidence: Evidence[];
  inv: { invoice_number: string } | null; po: { po_number: string } | null; dn: { dn_number: string } | null;
};

const originPill = (o: string) => <Pill tone={o === "exact" ? "green" : o === "manual" ? "blue" : "amber"}>{o === "exact" ? "Exact" : o === "manual" ? "Manual" : "Suggested"}</Pill>;
const amountOf = (e: NonNullable<M["soa"]>) => (e.entry_type === "credit_note" || e.entry_type === "payment" ? Number(e.credit) - Number(e.debit) : Number(e.debit) - Number(e.credit));

export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; periodId: string }>;
  searchParams: Promise<{ error?: string; saved?: string; ran?: string }>;
}) {
  const { id, periodId } = await params;
  const sp = await searchParams;
  if (!isUuid(id) || !isUuid(periodId)) notFound();
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";

  const supabase = await createClient();
  const [{ data: supplier }, { data: period }, { data: run }] = await Promise.all([
    supabase.from("suppliers").select("code, name").eq("id", id).maybeSingle(),
    supabase.from("reconciliation_periods").select("id, status, period_start, period_end, reported_closing_balance").eq("id", periodId).eq("supplier_id", id).maybeSingle(),
    supabase.from("reconciliation_runs").select("run_number, created_at, summary").eq("period_id", periodId).order("run_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!supplier || !period) notFound();
  const closed = period.status === "completed" || period.status === "locked";

  const [matches, links, soa, invoices, payments, pos, dns] = await Promise.all([
    fetchAll<M>((a, b) => supabase.from("matches").select("id, soa_entry_id, invoice_id, payment_id, origin, state, confidence, evidence, reject_reason, soa:soa_entries(doc_number, doc_date, entry_type, debit, credit), inv:invoices(invoice_number, gross_amount, invoice_date, doc_type), pay:payments(payment_ref, amount, payment_date)").eq("period_id", periodId).in("state", ["pending", "confirmed"]).order("confidence", { ascending: false }).order("id").range(a, b)),
    fetchAll<L>((a, b) => supabase.from("doc_links").select("id, invoice_id, po_id, dn_id, origin, state, confidence, evidence, inv:invoices(invoice_number), po:po_headers(po_number), dn:dn_headers(dn_number)").eq("supplier_id", id).in("state", ["pending", "confirmed"]).order("id").range(a, b)),
    fetchAll<{ id: string; doc_number: string; doc_date: string; entry_type: string; debit: string; credit: string }>((a, b) => supabase.from("soa_entries").select("id, doc_number, doc_date, entry_type, debit, credit").eq("period_id", periodId).is("deleted_at", null).in("entry_type", ["invoice", "credit_note", "payment"]).order("source_row").range(a, b)),
    fetchAll<{ id: string; invoice_number: string; gross_amount: string; invoice_date: string; doc_type: string }>((a, b) => supabase.from("invoices").select("id, invoice_number, gross_amount, invoice_date, doc_type").eq("supplier_id", id).is("deleted_at", null).order("invoice_date").order("id").range(a, b)),
    fetchAll<{ id: string; payment_ref: string; amount: string; payment_date: string }>((a, b) => supabase.from("payments").select("id, payment_ref, amount, payment_date").eq("supplier_id", id).is("deleted_at", null).order("payment_date").order("id").range(a, b)),
    fetchAll<{ id: string; po_number: string }>((a, b) => supabase.from("po_headers").select("id, po_number").eq("supplier_id", id).is("deleted_at", null).order("po_number").range(a, b)),
    fetchAll<{ id: string; dn_number: string }>((a, b) => supabase.from("dn_headers").select("id, dn_number").eq("supplier_id", id).is("deleted_at", null).order("dn_number").range(a, b)),
  ]);

  const pending = matches.filter((m) => m.state === "pending");
  const confirmed = matches.filter((m) => m.state === "confirmed");
  const matchedSoa = new Set(matches.map((m) => m.soa_entry_id));
  const usedTargets = new Set(confirmed.map((m) => m.invoice_id ?? m.payment_id));
  const pendingTargets = new Set(pending.map((m) => m.invoice_id ?? m.payment_id));
  const unmatchedSoa = soa.filter((e) => !matchedSoa.has(e.id));
  const freeInvoices = invoices.filter((i) => !usedTargets.has(i.id) && !pendingTargets.has(i.id));
  const freePayments = payments.filter((p) => !usedTargets.has(p.id) && !pendingTargets.has(p.id));
  const pendingLinks = links.filter((l) => l.state === "pending");
  const confirmedLinks = links.filter((l) => l.state === "confirmed");

  const summary = (run?.summary ?? null) as (Record<string, unknown> & { waterfall?: Waterfall }) | null;
  const w = summary?.waterfall;
  const hidden = { supplier_id: id, period_id: periodId };
  const base = `/suppliers/${id}/periods/${periodId}`;

  const evidenceList = (ev: Evidence[]) => (
    <ul className="mt-1 space-y-0.5 text-xs">
      {(ev ?? []).map((e, i) => <li key={i} className={e.supports ? "text-green-700" : "text-slate-600"}>{e.supports ? "✓" : "•"} {e.detail}</li>)}
    </ul>
  );

  let ranMsg: string | null = null;
  if (sp.ran) { const [n, nw, ar] = sp.ran.split(":"); ranMsg = `Reconciliation run #${n} finished: ${nw} new discrepancy item(s)${Number(ar) > 0 ? `, ${ar} resolved automatically` : ""}.`; }

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { href: `/suppliers/${id}`, label: supplier.code }, { href: base, label: `${fmtDate(period.period_start)} – ${fmtDate(period.period_end)}` }, { label: "Reconciliation" }]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reconciliation</h1>
          <p className="text-sm text-slate-600">{supplier.name} · {run ? `last run #${run.run_number} on ${fmtDateTime(run.created_at)}` : "not run yet"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-secondary" href={`/discrepancies?supplier=${id}&period=${periodId}`}>Discrepancies</Link>
          <a className="btn-secondary" href={`/suppliers/${id}/periods/${periodId}/export`}>Export to Excel</a>
          {canEdit && !closed && (
            <form action={runReconciliation}>
              {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <button className="btn" type="submit">Run reconciliation</button>
            </form>
          )}
        </div>
      </div>

      {sp.error && <Alert kind="error">{sp.error}</Alert>}
      {ranMsg && <Alert kind="success">{ranMsg}</Alert>}
      {sp.saved && <Alert kind="success">Saved.</Alert>}
      {closed && <Alert kind="info">This period is {period.status}. Matches and runs are frozen.</Alert>}

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Balance comparison</h2>
        {w ? (
          <>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between gap-4"><dt>Supplier-reported closing balance</dt><dd>{w.reportedClosing ? fmtMoney(w.reportedClosing) : "not entered"}</dd></div>
              <div className="flex justify-between gap-4"><dt>Our calculated closing balance</dt><dd>{fmtMoney(w.internalClosing)}</dd></div>
              <div className={`flex justify-between gap-4 border-t border-slate-300 pt-1 font-medium ${w.difference && Number(w.difference) !== 0 ? "text-red-700" : "text-green-700"}`}><dt>Difference (supplier − ours)</dt><dd>{w.difference ? fmtMoney(w.difference) : "—"}</dd></div>
            </dl>
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <p className="mb-2 font-medium">What explains the difference</p>
              <table className="w-full text-sm tabular-nums">
                <tbody>
                  {w.buckets.filter((b) => b.key !== "pending_suggestions").map((b) => (
                    <tr key={b.key}><td className="py-0.5 pr-3">{b.label} <span className="text-xs text-slate-500">({b.count})</span></td><td className="text-right">{fmtMoney(b.amount)}</td></tr>
                  ))}
                  <tr className="border-t border-slate-300 font-medium"><td className="py-1">Not explained</td><td className="text-right">{w.unexplained ? fmtMoney(w.unexplained) : "—"}</td></tr>
                </tbody>
              </table>
              {w.notes.map((n, i) => <p key={i} className="mt-2 text-xs text-slate-500">{n}</p>)}
            </div>
          </>
        ) : <p className="text-sm text-slate-500">Run the reconciliation to compare the supplier&apos;s statement with your records.</p>}
      </section>

      {pending.length > 0 && (
        <section className="card space-y-2">
          <h2 className="font-semibold">Suggested matches to confirm ({pending.length})</h2>
          <p className="text-xs text-slate-600">Suggestions are never applied on their own. Check the evidence, then confirm or reject.</p>
          <ul className="divide-y divide-slate-100">
            {pending.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div>
                  <div className="font-medium">Statement {m.soa?.doc_number} ({fmtDate(m.soa?.doc_date)}, {m.soa ? fmtMoney(amountOf(m.soa)) : ""}) ↔ {m.inv ? `invoice ${m.inv.invoice_number} (${fmtDate(m.inv.invoice_date)}, ${fmtMoney(m.inv.gross_amount)})` : `payment ${m.pay?.payment_ref} (${fmtMoney(m.pay?.amount)})`} {originPill(m.origin)} <span className="text-xs text-slate-500">confidence {m.confidence}%</span></div>
                  {evidenceList(m.evidence)}
                </div>
                {canEdit && !closed && (
                  <div className="flex gap-2">
                    <form action={decideMatch}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="decision" value="confirm" />{Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}<button className="btn" type="submit">Confirm</button></form>
                    <form action={decideMatch}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="decision" value="reject" />{Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}<button className="btn-secondary" type="submit">Reject</button></form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="font-semibold">Statement lines with no match ({unmatchedSoa.length})</h2>
        {unmatchedSoa.length === 0 ? <p className="text-sm text-slate-500">Every invoice, credit note and payment line on the statement is matched or waiting for confirmation.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-3">Document</th><th className="pr-3">Date</th><th className="pr-3">Type</th><th className="pr-3 text-right">Amount</th>{canEdit && !closed && <th className="pl-3">Match it with</th>}</tr></thead>
              <tbody>
                {unmatchedSoa.slice(0, 200).map((e) => {
                  const isPay = e.entry_type === "payment";
                  const options = isPay ? freePayments.map((p) => ({ v: `payment:${p.id}`, l: `Payment ${p.payment_ref} · ${fmtDate(p.payment_date)} · ${fmtMoney(p.amount)}` }))
                    : freeInvoices.filter((i) => (e.entry_type === "credit_note") === (i.doc_type === "credit_note")).map((i) => ({ v: `invoice:${i.id}`, l: `${i.invoice_number} · ${fmtDate(i.invoice_date)} · ${fmtMoney(i.gross_amount)}` }));
                  return (
                    <tr key={e.id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="py-2 pr-3 font-medium">{e.doc_number}</td><td className="pr-3">{fmtDate(e.doc_date)}</td><td className="pr-3">{e.entry_type.replace("_", " ")}</td>
                      <td className="pr-3 text-right tabular-nums">{fmtMoney(amountOf({ ...e } as NonNullable<M["soa"]>))}</td>
                      {canEdit && !closed && (
                        <td className="pl-3">
                          <form action={manualMatch} className="flex gap-2">
                            {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                            <input type="hidden" name="soa_entry_id" value={e.id} />
                            <select name="target" required className="input max-w-[260px] !py-1 text-xs" defaultValue="">
                              <option value="" disabled>Choose…</option>
                              {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                            </select>
                            <button className="btn-secondary !py-1" type="submit">Match</button>
                          </form>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {unmatchedSoa.length > 200 && <p className="mt-2 text-xs text-slate-500">Showing the first 200 of {unmatchedSoa.length}.</p>}
          </div>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Confirmed matches ({confirmed.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-3">Statement</th><th className="pr-3">Matched with</th><th className="pr-3">How</th><th className="pr-3 text-right">Statement amount</th><th className="pr-3 text-right">Our amount</th>{canEdit && !closed && <th />}</tr></thead>
            <tbody>
              {confirmed.slice(0, 300).map((m) => {
                const ours = m.inv ? Number(m.inv.gross_amount) : Number(m.pay?.amount ?? 0);
                const theirs = m.soa ? amountOf(m.soa) : 0;
                const diff = Math.abs(ours - theirs) > 0.05;
                return (
                  <tr key={m.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{m.soa?.doc_number}</td>
                    <td className="pr-3">{m.inv ? `Invoice ${m.inv.invoice_number}` : `Payment ${m.pay?.payment_ref}`}</td>
                    <td className="pr-3">{originPill(m.origin)}</td>
                    <td className="pr-3 text-right tabular-nums">{fmtMoney(theirs.toFixed(2))}</td>
                    <td className={`pr-3 text-right tabular-nums ${diff ? "font-medium text-red-700" : ""}`}>{fmtMoney(ours.toFixed(2))}</td>
                    {canEdit && !closed && (
                      <td className="text-right">
                        <form action={decideMatch} className="flex justify-end gap-1">
                          <input type="hidden" name="id" value={m.id} /><input type="hidden" name="decision" value="reject" />{Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                          <input name="reason" required placeholder="Reason to unmatch" className="input !w-40 !py-1 text-xs" />
                          <button className="btn-secondary !py-1" type="submit">Unmatch</button>
                        </form>
                      </td>
                    )}
                  </tr>
                );
              })}
              {confirmed.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-slate-500">No confirmed matches yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Invoice links to purchase orders and delivery notes</h2>
        {pendingLinks.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {pendingLinks.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 py-2 text-sm">
                <div>Invoice <b>{l.inv?.invoice_number}</b> ↔ {l.po ? `PO ${l.po.po_number}` : `delivery note ${l.dn?.dn_number}`} {originPill(l.origin)} <span className="text-xs text-slate-500">{l.confidence}%</span>{evidenceList(l.evidence)}</div>
                {canEdit && (
                  <div className="flex gap-2">
                    {(["confirm", "reject"] as const).map((d) => (
                      <form key={d} action={decideMatch}><input type="hidden" name="table" value="doc_links" /><input type="hidden" name="id" value={l.id} /><input type="hidden" name="decision" value={d} />{Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}<button className={d === "confirm" ? "btn" : "btn-secondary"} type="submit">{d === "confirm" ? "Confirm" : "Reject"}</button></form>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-slate-600">{confirmedLinks.length} confirmed link(s) · {pendingLinks.length} waiting.</p>
        {canEdit && !closed && (
          <form action={manualLink} className="flex flex-wrap items-end gap-2">
            {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <div><label className="label" htmlFor="invoice_id">Invoice</label>
              <select id="invoice_id" name="invoice_id" required className="input" defaultValue=""><option value="" disabled>Choose…</option>{invoices.filter((i) => i.doc_type === "invoice").map((i) => <option key={i.id} value={i.id}>{i.invoice_number}</option>)}</select></div>
            <div><label className="label" htmlFor="target">PO or delivery note</label>
              <select id="target" name="target" required className="input" defaultValue=""><option value="" disabled>Choose…</option>
                <optgroup label="Purchase orders">{pos.map((p) => <option key={p.id} value={`po:${p.id}`}>PO {p.po_number}</option>)}</optgroup>
                <optgroup label="Delivery notes">{dns.map((x) => <option key={x.id} value={`dn:${x.id}`}>DN {x.dn_number}</option>)}</optgroup></select></div>
            <button className="btn-secondary" type="submit">Link manually</button>
          </form>
        )}
      </section>
    </div>
  );
}
