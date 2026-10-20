"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, isUuid, userMessage, withParams } from "@/lib/forms";
import { reconcile } from "@/lib/reconcile/engine";
import { buildEngineInput } from "@/lib/reconcile/load";

const EDITORS = ["admin", "accountant"] as const;
const page = (f: Record<string, string>, extra: Record<string, string | undefined> = {}) =>
  withParams(`/suppliers/${f.supplier_id}/periods/${f.period_id}/reconcile`, extra);

export async function runReconciliation(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  if (!isUuid(f.supplier_id ?? "") || !isUuid(f.period_id ?? "")) redirect("/suppliers");
  const supabase = await createClient();
  let target: string;
  try {
    const input = await buildEngineInput(supabase, f.supplier_id, f.period_id);
    const result = reconcile(input);
    const { data, error } = await supabase.rpc("save_reconciliation_run", {
      p_period_id: f.period_id,
      p_settings: input.settings,
      p_summary: { ...result.summary, waterfall: result.waterfall },
      p_matches: result.matches,
      p_links: result.links,
      p_findings: result.findings,
    });
    if (error) throw new Error(error.message);
    const r = data as { run_number: number; discrepancies_new: number; auto_resolved: number };
    revalidatePath(`/suppliers/${f.supplier_id}`);
    target = page(f, { ran: `${r.run_number}:${r.discrepancies_new}:${r.auto_resolved}` });
  } catch (e) {
    target = page(f, { error: userMessage(e, "The reconciliation could not be completed.") });
  }
  redirect(target);
}

/** confirm | reject a suggested match, or unmatch (reject) a confirmed one with a reason. */
export async function decideMatch(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const table = f.table === "doc_links" ? "doc_links" : "matches";
  const patch =
    f.decision === "confirm"
      ? { state: "confirmed" }
      : { state: "rejected", reject_reason: (f.reason ?? "").trim() || null };
  const { error } = await supabase.from(table).update(patch).eq("id", f.id).in("state", f.decision === "confirm" ? ["pending"] : ["pending", "confirmed"]);
  if (error) redirect(page(f, { error: error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/periods/${f.period_id}`);
  redirect(page(f, { saved: f.decision === "confirm" ? "confirmed" : "rejected" }));
}

/** A person pairs a statement line with an invoice or a payment. */
export async function manualMatch(formData: FormData) {
  await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const [kind, target] = (f.target ?? "").split(":");
  if (!isUuid(f.soa_entry_id ?? "") || !isUuid(target ?? "") || !["invoice", "payment"].includes(kind)) {
    redirect(page(f, { error: "Choose a statement line and what it matches." }));
  }
  const { error } = await supabase.from("matches").insert({
    period_id: f.period_id,
    soa_entry_id: f.soa_entry_id,
    invoice_id: kind === "invoice" ? target : null,
    payment_id: kind === "payment" ? target : null,
    origin: "manual",
    state: "confirmed",
    evidence: [{ kind: "manual", detail: f.note?.trim() || "Matched by a person", supports: true }],
  });
  if (error) redirect(page(f, { error: /duplicate key/.test(error.message) ? "That statement line or document is already matched." : error.message }));
  revalidatePath(`/suppliers/${f.supplier_id}/periods/${f.period_id}`);
  redirect(page(f, { saved: "matched" }));
}

/** A person links an invoice to a purchase order or a delivery note. */
export async function manualLink(formData: FormData) {
  const profile = await requireRole([...EDITORS]);
  const f = formToObject(formData);
  const supabase = await createClient();
  const [kind, target] = (f.target ?? "").split(":");
  if (!isUuid(f.invoice_id ?? "") || !isUuid(target ?? "") || !["po", "dn"].includes(kind)) {
    redirect(page(f, { error: "Choose an invoice and a purchase order or delivery note." }));
  }
  const { error } = await supabase.from("doc_links").insert({
    supplier_id: f.supplier_id,
    invoice_id: f.invoice_id,
    po_id: kind === "po" ? target : null,
    dn_id: kind === "dn" ? target : null,
    origin: "manual",
    state: "confirmed",
    confidence: 100,
    decided_by: profile.id,
    decided_at: new Date().toISOString(),
    evidence: [{ kind: "manual", detail: "Linked by a person", supports: true }],
  });
  if (error) redirect(page(f, { error: /duplicate key/.test(error.message) ? "That link already exists." : error.message }));
  redirect(page(f, { saved: "linked" }));
}
