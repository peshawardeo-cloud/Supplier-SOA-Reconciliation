"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, isUuid, withParams } from "@/lib/forms";
import { d, parseAmount, round2 } from "@/lib/money";
import { REFUND_STATUSES, REFUND_TYPES } from "@/lib/discrepancy";

const back = (f: Record<string, string>, extra: Record<string, string | undefined> = {}) => withParams("/refunds", { supplier: f.supplier_id, ...extra });

export async function createRefund(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const amount = parseAmount(f.amount_claimed);
  if (!isUuid(f.supplier_id ?? "") || !(REFUND_TYPES as readonly string[]).includes(f.claim_type ?? "") || !amount || !amount.gt(0)) {
    redirect(back(f, { error: "Choose a supplier, a type and an amount greater than zero." }));
  }
  const supabase = await createClient();
  const { error } = await supabase.from("refund_claims").insert({
    supplier_id: f.supplier_id,
    period_id: isUuid(f.period_id ?? "") ? f.period_id : null,
    discrepancy_id: isUuid(f.discrepancy_id ?? "") ? f.discrepancy_id : null,
    claim_ref: (f.claim_ref ?? "").trim() || null,
    claim_type: f.claim_type,
    amount_claimed: round2(amount).toFixed(2),
    notes: (f.notes ?? "").trim() || null,
  });
  if (error) redirect(back(f, { error: /duplicate key/.test(error.message) ? "A claim with this reference already exists for the supplier." : error.message }));
  revalidatePath("/refunds");
  redirect(back(f, { saved: "1" }));
}

export async function updateRefund(formData: FormData) {
  await requireRole(["admin", "accountant"]);
  const f = formToObject(formData);
  const received = parseAmount(f.amount_received) ?? d(0);
  if (!isUuid(f.id ?? "") || !(REFUND_STATUSES as readonly string[]).includes(f.status ?? "") || received.isNegative()) redirect(back(f, { error: "Check the status and the amount received." }));
  const supabase = await createClient();
  const { error } = await supabase
    .from("refund_claims")
    .update({
      status: f.status,
      amount_received: round2(received).toFixed(2),
      submitted_at: /^\d{4}-\d{2}-\d{2}$/.test(f.submitted_at ?? "") ? f.submitted_at : null,
      notes: (f.notes ?? "").trim() || null,
    })
    .eq("id", f.id);
  if (error) redirect(back(f, { error: /refund_received_ok/.test(error.message) ? "The amount received cannot be more than the amount claimed." : error.message }));
  revalidatePath("/refunds");
  redirect(back(f, { saved: "1" }));
}
