"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, isUuid, withParams } from "@/lib/forms";
import { d, parseAmount, round2 } from "@/lib/money";
import { normalizeDocNumber, type DocNumberRules } from "@/lib/reconcile/normalize";

const back = (f: Record<string, string>, extra: Record<string, string | undefined> = {}) =>
  withParams(`/suppliers/${f.supplier_id}/allocations`, extra);

function amountOf(raw: string | undefined) {
  const a = parseAmount(raw);
  return a && a.gt(0) ? round2(a).toFixed(2) : null;
}

export async function addPayment(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const amount = amountOf(f.amount);
  const ref = (f.payment_ref ?? "").trim();
  if (!isUuid(f.supplier_id ?? "")) redirect("/suppliers");
  if (!ref || !amount || !/^\d{4}-\d{2}-\d{2}$/.test(f.payment_date ?? "")) {
    redirect(back(f, { error: "Enter a payment reference, a date and an amount greater than zero." }));
  }
  const supabase = await createClient();
  const { data: st } = await supabase.from("app_settings").select("doc_number_rules").eq("id", true).maybeSingle();
  const rules = (st?.doc_number_rules ?? {}) as DocNumberRules;
  const bank = (f.bank_ref ?? "").trim();
  const { error } = await supabase.from("payments").insert({
    supplier_id: f.supplier_id, payment_ref: ref, payment_ref_norm: normalizeDocNumber(ref, rules), payment_date: f.payment_date, amount,
    method: (f.method ?? "").trim() || null, bank_ref: bank || null, bank_ref_norm: bank ? normalizeDocNumber(bank, rules) : null,
    notes: (f.notes ?? "").trim() || null, source: "manual", raw: {},
  });
  if (error) redirect(back(f, { error: /duplicate key/.test(error.message) ? "A payment with this reference, date and amount already exists." : error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/allocations`);
  redirect(back(f, { saved: "payment" }));
}

export async function allocatePayment(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const amount = amountOf(f.amount);
  if (!amount || !isUuid(f.invoice_id ?? "") || !isUuid(f.payment_id ?? "")) redirect(back(f, { error: "Choose an invoice and enter an amount." }));
  const supabase = await createClient();
  const { error } = await supabase.from("payment_allocations").insert({ payment_id: f.payment_id, invoice_id: f.invoice_id, amount, note: (f.note ?? "").trim() || null });
  if (error) redirect(back(f, { error: /duplicate key/.test(error.message) ? "This payment is already applied to that invoice. Void it first to change the amount." : error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/allocations`);
  redirect(back(f, { saved: "allocated" }));
}

export async function allocateCredit(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const amount = amountOf(f.amount);
  if (!amount || !isUuid(f.invoice_id ?? "") || !isUuid(f.credit_note_id ?? "")) redirect(back(f, { error: "Choose an invoice and enter an amount." }));
  const supabase = await createClient();
  const { error } = await supabase.from("credit_allocations").insert({ credit_note_id: f.credit_note_id, invoice_id: f.invoice_id, amount, note: (f.note ?? "").trim() || null });
  if (error) redirect(back(f, { error: /duplicate key/.test(error.message) ? "This credit note is already applied to that invoice. Void it first to change the amount." : error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/allocations`);
  redirect(back(f, { saved: "allocated" }));
}

/** Oldest invoice first. Only runs when a person presses the button; nothing is allocated automatically. */
export async function fifoAllocate(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const [{ data: pays }, { data: invs }] = await Promise.all([
    supabase.rpc("payment_balances", { p_supplier_id: f.supplier_id }),
    supabase.rpc("invoice_balances", { p_supplier_id: f.supplier_id }),
  ]);
  const pay = ((pays ?? []) as { payment_id: string; unallocated: string }[]).find((p) => p.payment_id === f.payment_id);
  if (!pay || !d(pay.unallocated).gt(0)) redirect(back(f, { error: "That payment has nothing left to apply." }));
  let left = d(pay.unallocated);
  let n = 0;
  for (const i of (invs ?? []) as { invoice_id: string; doc_type: string; open_amount: string }[]) {
    if (left.lte(0)) break;
    if (i.doc_type !== "invoice" || !d(i.open_amount).gt(0)) continue;
    const take = d(i.open_amount).lt(left) ? d(i.open_amount) : left;
    const { error } = await supabase.from("payment_allocations").insert({ payment_id: f.payment_id, invoice_id: i.invoice_id, amount: take.toFixed(2), note: "Applied oldest invoice first" });
    if (error) redirect(back(f, { error: error.message }));
    left = left.minus(take);
    n++;
  }
  revalidatePath(`/suppliers/${f.supplier_id}/allocations`);
  redirect(back(f, { saved: n ? `fifo:${n}` : undefined, error: n ? undefined : "There are no open invoices to apply this payment to." }));
}

export async function voidAllocation(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const table = f.kind === "credit" ? "credit_allocations" : "payment_allocations";
  const reason = (f.reason ?? "").trim();
  if (!reason) redirect(back(f, { error: "A reason is required to void an allocation." }));
  const supabase = await createClient();
  const { error } = await supabase.from(table).update({ voided_at: new Date().toISOString(), void_reason: reason }).eq("id", f.id).is("voided_at", null);
  if (error) redirect(back(f, { error: error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/allocations`);
  redirect(back(f, { saved: "voided" }));
}
