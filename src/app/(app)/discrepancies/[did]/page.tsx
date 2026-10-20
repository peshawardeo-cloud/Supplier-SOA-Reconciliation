import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { Alert, Breadcrumbs, Field, Pill } from "@/components/ui";
import { DISCREPANCY_STATUSES, STATUS_LABEL, STATUS_TONE, typeLabel, type DiscrepancyStatus } from "@/lib/discrepancy";
import { addComment, updateDiscrepancy } from "../actions";

type Calc = { steps: { label: string; value: string }[]; result?: string } | null;

export default async function DiscrepancyDetail({
  params,
  searchParams,
}: {
  params: Promise<{ did: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { did } = await params;
  const sp = await searchParams;
  if (!isUuid(did)) notFound();
  const { profile } = await getSessionProfile();
  const canEdit = profile?.role === "admin" || profile?.role === "accountant";
  const supabase = await createClient();

  const [{ data: x }, { data: history }, { data: people }] = await Promise.all([
    supabase.from("discrepancies").select("*, supplier:suppliers(id, code, name), period:reconciliation_periods(id, period_start, period_end)").eq("id", did).maybeSingle(),
    supabase.from("discrepancy_history").select("id, changed_at, changed_by, field, old_value, new_value, comment").eq("discrepancy_id", did).order("changed_at", { ascending: false }).order("id", { ascending: false }),
    supabase.rpc("user_directory"),
  ]);
  if (!x) notFound();
  const names = new Map(((people ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]));
  const calc = x.calculation as Calc;
  const status = x.status as DiscrepancyStatus;
  const FIELD: Record<string, string> = { created: "Created", status: "Status", assigned_to: "Assigned to", notes: "Notes", resolution_note: "Resolution note", expected_amount: "Expected amount", actual_amount: "Actual amount", explanation: "Explanation", comment: "Comment" };
  const show = (field: string, v: string | null) => (field === "assigned_to" ? (v ? names.get(v) ?? "someone" : "nobody") : field === "status" && v ? STATUS_LABEL[v as DiscrepancyStatus] ?? v : v ?? "—");

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ href: "/discrepancies", label: "Discrepancies" }, { label: typeLabel(x.type) }]} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{typeLabel(x.type)}</h1>
          <p className="text-sm text-slate-600">
            <Link className="hover:underline" href={`/suppliers/${x.supplier?.id}`}>{x.supplier?.name}</Link>
            {x.period && <> · <Link className="hover:underline" href={`/suppliers/${x.supplier?.id}/periods/${x.period.id}/reconcile`}>{fmtDate(x.period.period_start)} – {fmtDate(x.period.period_end)}</Link></>}
            {x.ref_text && <> · {x.ref_text}</>}
          </p>
        </div>
        <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
      </div>
      {sp.error && <Alert kind="error">{sp.error}</Alert>}
      {sp.saved && <Alert kind="success">Saved.</Alert>}

      <section className="card space-y-3">
        <p className="text-sm">{x.explanation}</p>
        {(x.expected_amount !== null || x.actual_amount !== null) && (
          <dl className="grid max-w-md grid-cols-2 gap-1 text-sm tabular-nums">
            <dt className="text-slate-500">Expected</dt><dd className="text-right">{fmtMoney(x.expected_amount)}</dd>
            <dt className="text-slate-500">Actual</dt><dd className="text-right">{fmtMoney(x.actual_amount)}</dd>
            <dt className="font-medium">Difference</dt><dd className="text-right font-medium">{fmtMoney(x.difference)}</dd>
          </dl>
        )}
        {calc?.steps && (
          <div className="rounded-md bg-slate-50 p-3 text-sm">
            <p className="mb-1 font-medium">How this was calculated</p>
            <table className="w-full tabular-nums"><tbody>
              {calc.steps.map((s, i) => <tr key={i}><td className="py-0.5 pr-3">{s.label}</td><td className="text-right">{/^-?[\d,]+(\.\d+)?$/.test(s.value) ? fmtMoney(s.value) : s.value}</td></tr>)}
              {calc.result !== undefined && <tr className="border-t border-slate-300 font-medium"><td className="pt-1">Result</td><td className="pt-1 text-right">{fmtMoney(calc.result)}</td></tr>}
            </tbody></table>
          </div>
        )}
        <p className="text-xs text-slate-500">{x.source === "manual" ? "Added by hand." : "Found by the reconciliation run. The detected details cannot be edited; add notes below instead."}</p>
      </section>

      {canEdit ? (
        <form action={updateDiscrepancy} className="card grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="id" value={did} />
          <Field label="Status" htmlFor="status"><select id="status" name="status" defaultValue={x.status} className="input">{DISCREPANCY_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></Field>
          <Field label="Assigned to" htmlFor="assigned_to"><select id="assigned_to" name="assigned_to" defaultValue={x.assigned_to ?? ""} className="input"><option value="">Nobody</option>{((people ?? []) as { id: string; full_name: string }[]).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Notes" htmlFor="notes" className="sm:col-span-2"><textarea id="notes" name="notes" rows={3} defaultValue={x.notes ?? ""} className="input" /></Field>
          <Field label="Resolution note" htmlFor="resolution_note" hint="Required when resolving or closing." className="sm:col-span-2"><textarea id="resolution_note" name="resolution_note" rows={2} defaultValue={x.resolution_note ?? ""} className="input" /></Field>
          <div className="sm:col-span-2"><button className="btn" type="submit">Save</button></div>
        </form>
      ) : x.notes && <section className="card text-sm whitespace-pre-line">{x.notes}</section>}

      <section className="card space-y-3">
        <h2 className="font-semibold">History</h2>
        {canEdit && (
          <form action={addComment} className="flex gap-2"><input type="hidden" name="id" value={did} /><input name="comment" placeholder="Add a comment" className="input" /><button className="btn-secondary" type="submit">Add</button></form>
        )}
        <ul className="space-y-2 text-sm">
          {(history ?? []).map((h) => (
            <li key={h.id} className="border-l-2 border-slate-200 pl-3">
              <div className="text-xs text-slate-500">{fmtDateTime(h.changed_at)} · {h.changed_by ? names.get(h.changed_by) ?? "a user" : "System"}</div>
              {h.field === "comment" ? <div>{h.new_value}</div> : h.field === "created" ? <div>Created ({h.comment})</div> : <div><b>{FIELD[h.field] ?? h.field}:</b> {show(h.field, h.old_value)} → {show(h.field, h.new_value)}{h.comment && <span className="text-xs text-slate-500"> · {h.comment}</span>}</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
