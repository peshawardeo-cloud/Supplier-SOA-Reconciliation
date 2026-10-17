import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { fmtDate } from "@/lib/format";
import { Alert, Breadcrumbs } from "@/components/ui";
import { OPEN_PERIOD_STATUSES } from "@/lib/types";
import { startSoaImport } from "../actions";
import { SoaUploadForm } from "./upload-form";

// Reading a large PDF can take a few seconds.
export const maxDuration = 60;

export default async function SoaUploadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; periodId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin", "accountant"]);
  const { id, periodId } = await params;
  const { error } = await searchParams;
  if (!isUuid(id) || !isUuid(periodId)) notFound();

  const supabase = await createClient();
  const [{ data: supplier }, { data: period }] = await Promise.all([
    supabase.from("suppliers").select("id, code, name").eq("id", id).maybeSingle(),
    supabase.from("reconciliation_periods").select("id, status, period_start, period_end").eq("id", periodId).eq("supplier_id", id).maybeSingle(),
  ]);
  if (!supplier || !period) notFound();
  const open = OPEN_PERIOD_STATUSES.includes(period.status);

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          { href: "/suppliers", label: "Suppliers" },
          { href: `/suppliers/${id}`, label: supplier.code },
          { href: `/suppliers/${id}/periods/${periodId}`, label: `${fmtDate(period.period_start)} – ${fmtDate(period.period_end)}` },
          { label: "Import statement" },
        ]}
      />
      <h1 className="text-xl font-semibold">Import supplier statement (SOA)</h1>
      <p className="text-sm text-slate-600">
        {supplier.name} · {fmtDate(period.period_start)} – {fmtDate(period.period_end)}
      </p>

      {error && <Alert kind="error">{error}</Alert>}

      {open ? (
        <SoaUploadForm supplierId={id} periodId={periodId} action={startSoaImport} />
      ) : (
        <Alert kind="warning">This period is not open for imports. Change its status to Draft or In progress first.</Alert>
      )}

      <section className="card text-sm text-slate-700">
        <h2 className="mb-2 font-semibold">What happens next</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>The file is stored privately as evidence and checked for duplicates (the same file cannot be imported twice).</li>
          <li>PDF statements are read automatically. For Excel or CSV you choose which column is which.</li>
          <li>You review every row, the errors and possible duplicates, and the statement&apos;s own totals compared with what was read.</li>
          <li>Only after you confirm are the rows added to the period. Nothing is overwritten.</li>
        </ol>
      </section>
    </div>
  );
}
