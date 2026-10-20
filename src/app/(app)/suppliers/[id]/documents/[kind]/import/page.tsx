import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/forms";
import { Alert, Breadcrumbs } from "@/components/ui";
import { DOC_KINDS, DOC_KIND_LABEL, type DocKind } from "@/lib/import/doc-types";
import { startDocImport } from "../../actions";
import { DocUploadForm } from "./upload-form";

export const maxDuration = 60;

export default async function DocUploadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; kind: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin", "accountant"]);
  const { id, kind } = await params;
  const { error } = await searchParams;
  if (!isUuid(id) || !(DOC_KINDS as string[]).includes(kind)) notFound();
  const k = kind as DocKind;
  const supabase = await createClient();
  const { data: supplier } = await supabase.from("suppliers").select("id, code, name").eq("id", id).maybeSingle();
  if (!supplier) notFound();

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[{ href: "/suppliers", label: "Suppliers" }, { href: `/suppliers/${id}`, label: supplier.code }, { href: `/suppliers/${id}/documents/${k}`, label: DOC_KIND_LABEL[k] }, { label: "Import" }]} />
      <h1 className="text-xl font-semibold">Import {DOC_KIND_LABEL[k].toLowerCase()}</h1>
      <p className="text-sm text-slate-600">{supplier.name}</p>
      {error && <Alert kind="error">{error}</Alert>}
      <DocUploadForm supplierId={id} kind={k} allowPdf={k === "invoice"} action={startDocImport} />
      <section className="card text-sm text-slate-700">
        <h2 className="mb-2 font-semibold">How it works</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Each file is stored privately as evidence. The same file can never be imported twice.</li>
          <li>{k === "invoice" ? "Tax invoice PDFs are read automatically and their printed totals are checked against the lines. " : ""}For Excel/CSV you choose which column is which; the choice is remembered.</li>
          <li>Documents already in the system are skipped. If any line of a document has an error, the whole document is held back so nothing is half-imported.</li>
          <li>You review and confirm. Imported documents are never edited afterwards.</li>
        </ol>
      </section>
    </div>
  );
}
