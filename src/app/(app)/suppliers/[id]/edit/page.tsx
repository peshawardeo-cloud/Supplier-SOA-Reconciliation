import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { Alert, Breadcrumbs } from "@/components/ui";
import type { Supplier } from "@/lib/types";
import { updateSupplier } from "../../actions";
import { SupplierForm } from "../../supplier-form";

export default async function EditSupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin", "accountant"]);
  const { id } = await params;
  const { error } = await searchParams;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const { data: supplier } = await supabase
    .from("suppliers")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<Supplier>();
  if (!supplier) notFound();

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          { href: "/suppliers", label: "Suppliers" },
          { href: `/suppliers/${id}`, label: supplier.code },
          { label: "Edit" },
        ]}
      />
      <h1 className="text-xl font-semibold">Edit supplier</h1>
      {error && <Alert kind="error">{error}</Alert>}
      <SupplierForm
        action={updateSupplier}
        supplier={supplier}
        submitLabel="Save changes"
        cancelHref={`/suppliers/${id}`}
        defaultCurrency={supplier.currency}
      />
    </div>
  );
}
