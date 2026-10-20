"use client";

import { useRef, useState, useTransition } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

const MAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/csv",
};

export function DocUploadForm({
  supplierId,
  kind,
  allowPdf,
  action,
}: {
  supplierId: string;
  kind: string;
  allowPdf: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = uploading || pending;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const files = Array.from(fileRef.current?.files ?? []);
    if (files.length === 0) return setMessage("Choose at least one file.");
    if (files.length > 30) return setMessage("Please upload at most 30 files at a time.");
    for (const file of files) {
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      if (ext === "xls") return setMessage(`${file.name}: old .xls files are not supported. Save as .xlsx or CSV first.`);
      if (!TYPES[ext] || (ext === "pdf" && !allowPdf)) return setMessage(`${file.name}: unsupported file type.`);
      if (file.size > MAX_BYTES) return setMessage(`${file.name} is larger than 20 MB.`);
      if (file.size === 0) return setMessage(`${file.name} is empty.`);
    }

    setUploading(true);
    try {
      const supabase = createBrowserSupabase();
      const uploaded: { path: string; name: string }[] = [];
      for (const file of files) {
        const ext = file.name.toLowerCase().split(".").pop() ?? "";
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100);
        const path = `${supplierId}/${crypto.randomUUID()}-${safe}`;
        const { error } = await supabase.storage.from("imports").upload(path, file, { contentType: TYPES[ext], upsert: false });
        if (error) return setMessage(`Upload of ${file.name} failed: ${error.message}`);
        uploaded.push({ path, name: file.name });
      }
      const fd = new FormData();
      fd.set("supplier_id", supplierId);
      fd.set("kind", kind);
      fd.set("files", JSON.stringify(uploaded));
      startTransition(async () => {
        await action(fd);
      });
    } catch {
      setMessage("The upload could not be completed. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      <div>
        <label htmlFor="file" className="label">Files</label>
        <input
          ref={fileRef}
          id="file"
          type="file"
          multiple={allowPdf}
          accept={allowPdf ? ".pdf,.xlsx,.csv" : ".xlsx,.csv"}
          disabled={busy}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500">
          {allowPdf ? "Tax invoice PDFs (you can select many at once), Excel .xlsx or CSV" : "Excel .xlsx or CSV"} · up to 20 MB each
        </p>
      </div>
      {message && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>}
      <button type="submit" className="btn" disabled={busy}>
        {uploading ? "Uploading…" : pending ? "Reading the files…" : "Upload and preview"}
      </button>
      <p className="text-xs text-slate-500">Nothing is imported yet. You will see a preview and checks first.</p>
    </form>
  );
}
