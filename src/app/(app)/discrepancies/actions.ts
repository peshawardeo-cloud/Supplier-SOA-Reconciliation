"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, isUuid, withParams } from "@/lib/forms";
import { parseAmount, round2 } from "@/lib/money";
import { DISCREPANCY_STATUSES } from "@/lib/discrepancy";

const EDITORS = ["admin", "accountant"] as const;
const detail = (id: string, extra: Record<string, string | undefined> = {}) => withParams(`/discrepancies/${id}`, extra);

export async function updateDiscrepancy(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  if (!isUuid(f.id ?? "")) redirect("/discrepancies");
  const status = f.status ?? "";
  if (!(DISCREPANCY_STATUSES as readonly string[]).includes(status)) redirect(detail(f.id, { error: "Choose a valid status." }));
  const resolving = status === "resolved" || status === "closed";
  if (resolving && !(f.resolution_note ?? "").trim()) redirect(detail(f.id, { error: "Add a resolution note before resolving or closing." }));
  const supabase = await createClient();
  const { error } = await supabase
    .from("discrepancies")
    .update({
      status,
      assigned_to: isUuid(f.assigned_to ?? "") ? f.assigned_to : null,
      notes: (f.notes ?? "").trim() || null,
      resolution_note: (f.resolution_note ?? "").trim() || null,
    })
    .eq("id", f.id);
  if (error) redirect(detail(f.id, { error: error.message }));
  revalidatePath("/discrepancies");
  redirect(detail(f.id, { saved: "1" }));
}

export async function addComment(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const text = (f.comment ?? "").trim();
  if (!isUuid(f.id ?? "")) redirect("/discrepancies");
  if (!text) redirect(detail(f.id, { error: "Write a comment first." }));
  const supabase = await createClient();
  const { error } = await supabase.from("discrepancy_history").insert({ discrepancy_id: f.id, field: "comment", new_value: text.slice(0, 2000), comment: text.slice(0, 2000) });
  if (error) redirect(detail(f.id, { error: error.message }));
  redirect(detail(f.id, { saved: "1" }));
}

export async function createManualDiscrepancy(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  if (!isUuid(f.supplier_id ?? "")) redirect("/discrepancies?error=Choose%20a%20supplier");
  const explanation = (f.explanation ?? "").trim();
  if (explanation.length < 3) redirect(withParams("/discrepancies", { supplier: f.supplier_id, error: "Describe the discrepancy." }));
  const amt = (v: string | undefined) => { const a = parseAmount(v); return a ? round2(a).toFixed(2) : null; };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("discrepancies")
    .insert({
      supplier_id: f.supplier_id,
      period_id: isUuid(f.period_id ?? "") ? f.period_id : null,
      type: "manual_review",
      source: "manual",
      ref_text: (f.ref_text ?? "").trim() || null,
      expected_amount: amt(f.expected_amount),
      actual_amount: amt(f.actual_amount),
      explanation,
      fingerprint: `manual:${crypto.randomUUID()}`,
    })
    .select("id")
    .single();
  if (error || !data) redirect(withParams("/discrepancies", { supplier: f.supplier_id, error: error?.message ?? "Could not save." }));
  redirect(detail(data.id, { saved: "1" }));
}
