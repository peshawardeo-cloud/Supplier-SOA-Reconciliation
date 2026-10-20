import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { fmtDate, fmtMoney } from "@/lib/format";
import { d } from "@/lib/money";
import { Alert, Breadcrumbs, Field, Pill } from "@/components/ui";
import { REFUND_STATUSES, REFUND_STATUS_LABEL, REFUND_TYPES, REFUND_TYPE_LABEL } from "@/lib/discrepancy";
import { createRefund, updateRefund } from "./actions";

type Row = { id: string; claim_ref: string | null; claim_type: string; amount_claimed: string; amount_received: string; status: string; submitted_at: string | null; notes: string | null; created_at: string; supplier: { code: string; name: string } | null };

export default async function RefundsPage({ searchParams }: { searchParams: Promise<{ supplier?: string; error?: string; saved?: string }> }) {
  const sp = await searchParams;
  const supplier = isUuid(sp.supplier ?? "") ? sp.supplier! : "";
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const supabase = await createClient();
  let q = supabase.from("refund_claims").select("id, claim_ref, claim_type, amount_claimed, amount_received, status, submitted_at, notes, created_at, supplier:suppliers(code, name)").order("created_at", { ascending: false }).limit(300);
  if (supplier) q = q.eq("supplier_id", supplier);
  const [{ data: rows }, { data: suppliers }] = await Promise.all([q.returns<Row[]>(), supabase.from("suppliers").select("id, code, name").is("deleted_at", null).order("code")]);

  const pendingTotal = (rows ?? []).filter((r) => !["received", "rejected"].includes(r.status)).reduce((a, r) => a.plus(r.amount_claimed).minus(r.amount_received), d(0));

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ label: "Refund claims" }]} />
      <h1 className="text-xl font-semibold">Refund claims</h1>
      <p className="text-sm text-slate-600">Money the supplier owes back to us (overpayments, duplicate payments, unrefunded credit notes). Still to collect: <b className="tabular-nums">{fmtMoney(pendingTotal.toFixed(2))}</b></p>
      {sp.error && <Alert kind="error">{sp.error}</Alert>}
      {sp.saved && <Alert kind="success">Saved.</Alert>}

      <form method="get" className="flex gap-2">
        <select name="supplier" defaultValue={supplier} className="input max-w-xs"><option value="">All suppliers</option>{(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select>
        <button className="btn-secondary" type="submit">Filter</button>
      </form>

      <div className="space-y-3">
        {(rows ?? []).map((r) => (
          <div key={r.id} className="card space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div><b>{r.supplier?.code}</b> · {REFUND_TYPE_LABEL[r.claim_type]} {r.claim_ref && <span className="text-slate-500">· {r.claim_ref}</span>}</div>
              <div className="flex items-center gap-2 tabular-nums"><span>Claimed {fmtMoney(r.amount_claimed)}</span><span>Received {fmtMoney(r.amount_received)}</span><Pill tone={r.status === "received" ? "green" : r.status === "rejected" ? "gray" : "amber"}>{REFUND_STATUS_LABEL[r.status]}</Pill></div>
            </div>
            {canEdit ? (
              <form action={updateRefund} className="grid gap-2 sm:grid-cols-5">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="supplier_id" value={supplier} />
                <select name="status" defaultValue={r.status} className="input !py-1 text-xs">{REFUND_STATUSES.map((s) => <option key={s} value={s}>{REFUND_STATUS_LABEL[s]}</option>)}</select>
                <input name="amount_received" inputMode="decimal" defaultValue={r.amount_received} className="input !py-1 text-xs" aria-label="Amount received" />
                <input name="submitted_at" type="date" defaultValue={r.submitted_at ?? ""} className="input !py-1 text-xs" aria-label="Date submitted" />
                <input name="notes" defaultValue={r.notes ?? ""} placeholder="Notes" className="input !py-1 text-xs" />
                <button className="btn-secondary !py-1" type="submit">Save</button>
              </form>
            ) : r.notes && <p className="text-sm text-slate-600">{r.notes}</p>}
            <p className="text-xs text-slate-500">Created {fmtDate(r.created_at)}{r.submitted_at && ` · submitted ${fmtDate(r.submitted_at)}`}</p>
          </div>
        ))}
        {(rows ?? []).length === 0 && <p className="card text-center text-sm text-slate-500">No refund claims yet.</p>}
      </div>

      {canEdit && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-blue-700">New refund claim</summary>
          <form action={createRefund} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Supplier *" htmlFor="r_supplier"><select id="r_supplier" name="supplier_id" required defaultValue={supplier} className="input"><option value="" disabled>Choose…</option>{(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Field>
            <Field label="Type *" htmlFor="claim_type"><select id="claim_type" name="claim_type" required className="input">{REFUND_TYPES.map((t) => <option key={t} value={t}>{REFUND_TYPE_LABEL[t]}</option>)}</select></Field>
            <Field label="Amount claimed *" htmlFor="amount_claimed"><input id="amount_claimed" name="amount_claimed" inputMode="decimal" required className="input" /></Field>
            <Field label="Claim reference" htmlFor="claim_ref"><input id="claim_ref" name="claim_ref" className="input" /></Field>
            <Field label="Notes" htmlFor="r_notes" className="sm:col-span-2"><input id="r_notes" name="notes" className="input" /></Field>
            <div className="sm:col-span-2 lg:col-span-3"><button className="btn" type="submit">Create claim</button></div>
          </form>
        </details>
      )}
    </div>
  );
}
