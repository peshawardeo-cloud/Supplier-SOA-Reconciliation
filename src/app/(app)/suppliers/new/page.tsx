import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Alert, Breadcrumbs } from "@/components/ui";
import { createSupplier } from "../actions";
import { SupplierForm } from "../supplier-form";

export default async function NewSupplierPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin", "accountant"]);
  const { error } = await searchParams;

  const supabase = await createClient();
  const { data: settings } = await supabase.from("app_settings").select("default_currency").eq("id", true).maybeSingle();

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { label: "New supplier" }]} />
      <h1 className="text-xl font-semibold">Add supplier</h1>
      {error && <Alert kind="error">{error}</Alert>}
      <SupplierForm
        action={createSupplier}
        submitLabel="Save supplier"
        cancelHref="/suppliers"
        defaultCurrency={settings?.default_currency ?? "SAR"}
      />
    </div>
  );
}
