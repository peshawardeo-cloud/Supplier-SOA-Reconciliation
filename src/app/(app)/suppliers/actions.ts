"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formToObject, withParams } from "@/lib/forms";
import { periodSchema, periodStatusSchema, supplierSchema } from "@/lib/schemas/supplier";

const EDITORS = ["admin", "accountant"] as const;

function firstIssue(e: { issues: { message: string }[] }) {
  return e.issues[0]?.message ?? "Please check the form.";
}

function splitAliases(raw: string | undefined): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.slice(0, 200)),
    ),
  ).slice(0, 20);
}

export async function createSupplier(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const parsed = supplierSchema.safeParse(fields);
  if (!parsed.success) redirect(withParams("/suppliers/new", { error: firstIssue(parsed.error) }));

  const supabase = await createClient();
  const { data, error } = await supabase.from("suppliers").insert(parsed.data).select("id").single();
  if (error) {
    const msg = error.code === "23505" ? "A supplier with this code already exists." : "Could not save the supplier.";
    redirect(withParams("/suppliers/new", { error: msg }));
  }

  const aliases = splitAliases(fields.aliases);
  if (aliases.length > 0) {
    await supabase.from("supplier_aliases").insert(aliases.map((alias_name) => ({ supplier_id: data.id, alias_name })));
  }

  revalidatePath("/suppliers");
  redirect(withParams(`/suppliers/${data.id}`, { saved: "created" }));
}

export async function updateSupplier(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const id = fields.id ?? "";
  const back = `/suppliers/${id}/edit`;

  const parsed = supplierSchema.safeParse(fields);
  if (!parsed.success) redirect(withParams(back, { error: firstIssue(parsed.error) }));

  const supabase = await createClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ ...parsed.data, is_active: fields.is_active === "on" })
    .eq("id", id);
  if (error) {
    const msg = error.code === "23505" ? "Another supplier already uses this code." : "Could not save the supplier.";
    redirect(withParams(back, { error: msg }));
  }

  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/${id}`);
  redirect(withParams(`/suppliers/${id}`, { saved: "updated" }));
}

export async function addAlias(formData: FormData) {
  await requireRole([...EDITORS]);
  const { supplier_id = "", alias_name = "" } = formToObject(formData);
  const alias = alias_name.trim().slice(0, 200);
  const back = `/suppliers/${supplier_id}`;
  if (!alias) redirect(withParams(back, { error: "Enter the alternative name." }));

  const supabase = await createClient();
  const { error } = await supabase.from("supplier_aliases").insert({ supplier_id, alias_name: alias });
  if (error && error.code !== "23505") redirect(withParams(back, { error: "Could not add the name." }));

  revalidatePath(back);
  redirect(withParams(back, { saved: "alias" }));
}

export async function createPeriod(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const back = `/suppliers/${fields.supplier_id ?? ""}`;

  const parsed = periodSchema.safeParse(fields);
  if (!parsed.success) redirect(withParams(back, { error: firstIssue(parsed.error) }));

  const supabase = await createClient();
  const { data, error } = await supabase.from("reconciliation_periods").insert(parsed.data).select("id").single();
  if (error) {
    const msg =
      error.code === "23505"
        ? "A period with these exact dates already exists for this supplier."
        : "Could not create the period.";
    redirect(withParams(back, { error: msg }));
  }

  revalidatePath(back);
  redirect(`${back}/periods/${data.id}`);
}

export async function updatePeriodStatus(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const parsed = periodStatusSchema.safeParse(fields);
  const back = `/suppliers/${fields.supplier_id ?? ""}/periods/${fields.period_id ?? ""}`;
  if (!parsed.success) redirect(withParams(back, { error: "Invalid status." }));

  const supabase = await createClient();
  const { error } = await supabase
    .from("reconciliation_periods")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.period_id)
    .eq("supplier_id", parsed.data.supplier_id);

  // The database enforces the lock rules and explains them in plain words.
  if (error) redirect(withParams(back, { error: error.message }));

  revalidatePath(back);
  redirect(withParams(back, { saved: "status" }));
}

export async function updatePeriodDetails(formData: FormData) {
  await requireRole([...EDITORS]);
  const fields = formToObject(formData);
  const back = `/suppliers/${fields.supplier_id ?? ""}/periods/${fields.period_id ?? ""}`;

  const parsed = periodSchema.safeParse({
    supplier_id: fields.supplier_id,
    period_start: fields.period_start,
    period_end: fields.period_end,
    statement_date: fields.statement_date ?? "",
    reported_opening_balance: fields.reported_opening_balance ?? "",
    reported_closing_balance: fields.reported_closing_balance ?? "",
    notes: fields.notes ?? "",
  });
  if (!parsed.success) redirect(withParams(back, { error: firstIssue(parsed.error) }));

  const { supplier_id, ...values } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase
    .from("reconciliation_periods")
    .update(values)
    .eq("id", fields.period_id)
    .eq("supplier_id", supplier_id);
  if (error) {
    const msg = error.code === "23505" ? "Another period already has these dates." : error.message;
    redirect(withParams(back, { error: msg }));
  }

  revalidatePath(back);
  redirect(withParams(back, { saved: "details" }));
}
