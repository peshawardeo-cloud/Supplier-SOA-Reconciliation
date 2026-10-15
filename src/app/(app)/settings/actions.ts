"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Decimal from "decimal.js";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { settingsFormSchema } from "@/lib/schemas/settings";

export async function saveSettings(formData: FormData) {
  const admin = await requireRole(["admin"]);

  const prefixes = String(formData.get("strip_prefixes") ?? "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  const parsed = settingsFormSchema.safeParse({
    vat_rate_percent: formData.get("vat_rate_percent"),
    amount_tolerance_abs: formData.get("amount_tolerance_abs"),
    amount_tolerance_percent: formData.get("amount_tolerance_percent"),
    qty_tolerance: formData.get("qty_tolerance"),
    date_window_days: formData.get("date_window_days"),
    default_currency: formData.get("default_currency"),
    strip_leading_zeros: formData.get("strip_leading_zeros") === "on",
    strip_prefixes: prefixes,
  });

  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid values";
    redirect("/settings?error=" + encodeURIComponent(msg));
  }

  const v = parsed.data;
  const supabase = await createClient();

  const { error } = await supabase
    .from("app_settings")
    .update({
      vat_rate: new Decimal(v.vat_rate_percent).div(100).toFixed(4),
      amount_tolerance_abs: new Decimal(v.amount_tolerance_abs).toFixed(2),
      amount_tolerance_pct: new Decimal(v.amount_tolerance_percent).div(100).toFixed(4),
      qty_tolerance: new Decimal(v.qty_tolerance).toFixed(3),
      date_window_days: v.date_window_days,
      default_currency: v.default_currency,
      doc_number_rules: {
        ignore_separators: true,
        strip_leading_zeros: v.strip_leading_zeros,
        strip_prefixes: v.strip_prefixes,
      },
      updated_by: admin.id,
    })
    .eq("id", true);

  if (error) {
    redirect("/settings?error=" + encodeURIComponent("Could not save settings."));
  }

  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
