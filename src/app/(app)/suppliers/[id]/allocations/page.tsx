import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/reconcile/load";
import { isUuid } from "@/lib/forms";
import { fmtDate, fmtMoney } from "@/lib/format";
import { d } from "@/lib/money";
import { Alert, Breadcrumbs, Field, Pill } from "@/components/ui";
import { addPayment, allocateCredit, allocatePayment, fifoAllocate, voidAllocation } from "./actions";

type Inv = { invoice_id: string; doc_type: string; invoice_number: string; invoice_date: string; gross: string; applied: string; open_amount: string };
type Pay = { payment_id: string; payment_ref: string; payment_date: string; amount: string; allocated: string; unallocated: string };
type Alloc = { id: string; amount: string; created_at: string; note: string | null; pay?: { payment_ref: string } | null; cn?: { invoice_number: string } | null; inv: { invoice_number: string } | null };

const SAVED: Record<string, string> = { payment: "Payment added.", allocated: "Allocation saved.", voided: "Allocation voided." };

export default async function AllocationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const supabase = await createClient();
  const { data: supplier } = await supabase.from("suppliers").select("code, name").eq("id", id).maybeSingle();
  if (!supplier) notFound();

  const [{ data: ib }, { data: pb }, payAllocs, crAllocs] = await Promise.all([
    supabase.rpc("invoice_balances", { p_supplier_id: id }),
    supabase.rpc("payment_balances", { p_supplier_id: id }),
    fetchAll<Alloc>((a, b) => supabase.from("payment_allocations").select("id, amount, created_at, note, pay:payments!inner(payment_ref, supplier_id), inv:invoices!payment_allocations_invoice_id_fkey(invoice_number)").eq("pay.supplier_id", id).is("voided_at", null).order("created_at", { ascending: false }).range(a, b)),
    fetchAll<Alloc>((a, b) => supabase.from("credit_allocations").select("id, amount, created_at, note, cn:invoices!credit_allocations_credit_note_id_fkey!inner(invoice_number, supplier_id), inv:invoices!credit_allocations_invoice_id_fkey(invoice_number)").eq("cn.supplier_id", id).is("voided_at", null).order("created_at", { ascending: false }).range(a, b)),
  ]);
  const invoices = (ib ?? []) as Inv[];
  const payments = (pb ?? []) as Pay[];
  const openInvoices = invoices.filter((i) => i.doc_type === "invoice" && d(i.open_amount).gt(0));
  const openPayments = payments.filter((p) => d(p.unallocated).gt(0));
  const openCredits = invoices.filter((i) => i.doc_type === "credit_note" && d(i.open_amount).gt(0));
  const hidden = <input type="hidden" name="supplier_id" value={id} />;
  const invoiceSelect = (
    <select name="invoice_id" required className="input !w-56 !py-1 text-xs" defaultValue="">
      <option value="" disabled>Apply to invoice…</option>
      {openInvoices.map((i) => <option key={i.invoice_id} value={i.invoice_id}>{i.invoice_number} · open {fmtMoney(i.open_amount)}</option>)}
    </select>
  );
  const savedMsg = sp.saved?.startsWith("fifo:") ? `Applied to ${sp.saved.split(":")[1]} invoice(s), oldest first.` : sp.saved ? SAVED[sp.saved] : null;

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { href: `/suppliers/${id}`, label: supplier.code }, { label: "Payments and credit notes" }]} />
      <h1 className="text-xl font-semibold">Payments and credit notes applied to invoices</h1>
      <p className="text-sm text-slate-600">{supplier.name}. A payment or credit note is counted once: it can only be applied up to its own amount, and an invoice can only be settled up to its total. Nothing is applied automatically.</p>
      {sp.error && <Alert kind="error">{sp.error}</Alert>}
      {savedMsg && <Alert kind="success">{savedMsg}</Alert>}

      <section className="card space-y-3">
        <h2 className="font-semibold">Payments not fully applied ({openPayments.length})</h2>
        {openPayments.length === 0 && <p className="text-sm text-slate-500">Every payment is fully applied.</p>}
        <ul className="divide-y divide-slate-100">
          {openPayments.map((p) => (
            <li key={p.payment_id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
              <div><b>{p.payment_ref}</b> · {fmtDate(p.payment_date)} · {fmtMoney(p.amount)} <Pill tone="amber">{fmtMoney(p.unallocated)} not applied</Pill></div>
              {canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <form action={allocatePayment} className="flex items-center gap-2">{hidden}<input type="hidden" name="payment_id" value={p.payment_id} />{invoiceSelect}
                    <input name="amount" inputMode="decimal" required defaultValue={p.unallocated} className="input !w-28 !py-1 text-xs" aria-label="Amount" /><button className="btn-secondary !py-1" type="submit">Apply</button></form>
                  <form action={fifoAllocate}>{hidden}<input type="hidden" name="payment_id" value={p.payment_id} /><button className="btn-secondary !py-1" type="submit" title="Applies to the oldest open invoices first">Apply oldest first</button></form>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Credit notes not fully applied ({openCredits.length})</h2>
        {openCredits.length === 0 && <p className="text-sm text-slate-500">None.</p>}
        <ul className="divide-y divide-slate-100">
          {openCredits.map((c) => (
            <li key={c.invoice_id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
              <div><b>{c.invoice_number}</b> · {fmtDate(c.invoice_date)} · {fmtMoney(c.gross)} <Pill tone="amber">{fmtMoney(c.open_amount)} unused</Pill></div>
              {canEdit && (
                <form action={allocateCredit} className="flex items-center gap-2">{hidden}<input type="hidden" name="credit_note_id" value={c.invoice_id} />{invoiceSelect}
                  <input name="amount" inputMode="decimal" required defaultValue={c.open_amount} className="input !w-28 !py-1 text-xs" aria-label="Amount" /><button className="btn-secondary !py-1" type="submit">Apply</button></form>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Open invoices ({openInvoices.length})</h2>
        <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-3">Invoice</th><th className="pr-3">Date</th><th className="pr-3 text-right">Gross</th><th className="pr-3 text-right">Applied</th><th className="text-right">Open</th></tr></thead>
          <tbody>{openInvoices.slice(0, 300).map((i) => <tr key={i.invoice_id} className="border-b border-slate-100 last:border-0"><td className="py-1.5 pr-3 font-medium">{i.invoice_number}</td><td className="pr-3">{fmtDate(i.invoice_date)}</td><td className="pr-3 text-right tabular-nums">{fmtMoney(i.gross)}</td><td className="pr-3 text-right tabular-nums">{fmtMoney(i.applied)}</td><td className="text-right tabular-nums">{fmtMoney(i.open_amount)}</td></tr>)}</tbody>
        </table></div>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Applied amounts</h2>
        <ul className="divide-y divide-slate-100 text-sm">
          {[...payAllocs.map((a) => ({ ...a, kind: "payment", from: a.pay?.payment_ref })), ...crAllocs.map((a) => ({ ...a, kind: "credit", from: a.cn?.invoice_number }))].slice(0, 300).map((a) => (
            <li key={`${a.kind}${a.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{a.kind === "credit" ? "Credit note" : "Payment"} <b>{a.from}</b> → invoice <b>{a.inv?.invoice_number}</b> · {fmtMoney(a.amount)}{a.note && <span className="text-xs text-slate-500"> · {a.note}</span>}</span>
              {canEdit && (
                <form action={voidAllocation} className="flex gap-1">{hidden}<input type="hidden" name="id" value={a.id} /><input type="hidden" name="kind" value={a.kind} />
                  <input name="reason" required placeholder="Reason to void" className="input !w-40 !py-1 text-xs" /><button className="btn-secondary !py-1" type="submit">Void</button></form>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canEdit && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-blue-700">Add a payment by hand</summary>
          <form action={addPayment} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {hidden}
            <Field label="Payment reference *" htmlFor="payment_ref"><input id="payment_ref" name="payment_ref" required className="input" /></Field>
            <Field label="Date *" htmlFor="payment_date"><input id="payment_date" name="payment_date" type="date" required className="input" /></Field>
            <Field label="Amount *" htmlFor="amount"><input id="amount" name="amount" inputMode="decimal" required className="input" /></Field>
            <Field label="Method" htmlFor="method"><input id="method" name="method" className="input" placeholder="Bank transfer, cheque…" /></Field>
            <Field label="Bank / cheque reference" htmlFor="bank_ref"><input id="bank_ref" name="bank_ref" className="input" /></Field>
            <Field label="Notes" htmlFor="notes"><input id="notes" name="notes" className="input" /></Field>
            <div className="sm:col-span-2 lg:col-span-3"><button className="btn" type="submit">Add payment</button></div>
          </form>
        </details>
      )}
      <p className="text-sm"><Link className="text-blue-700 hover:underline" href={`/suppliers/${id}/documents/payment`}>See all payments</Link></p>
    </div>
  );
}
