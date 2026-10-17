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

export function SoaUploadForm({
  supplierId,
  periodId,
  action,
}: {
  supplierId: string;
  periodId: string;
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
    const file = fileRef.current?.files?.[0];
    if (!file) return setMessage("Choose a file first.");

    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    if (ext === "xls") {
      return setMessage("Old .xls files are not supported. Save the file as .xlsx or CSV in Excel and choose that instead.");
    }
    if (!TYPES[ext]) return setMessage("Choose a PDF, Excel (.xlsx) or CSV file.");
    if (file.size > MAX_BYTES) return setMessage("The file is larger than 20 MB.");
    if (file.size === 0) return setMessage("The file is empty.");

    setUploading(true);
    try {
      const supabase = createBrowserSupabase();
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100);
      const path = `${supplierId}/${crypto.randomUUID()}-${safeName}`;
      const { error } = await supabase.storage.from("imports").upload(path, file, {
        contentType: TYPES[ext],
        upsert: false,
      });
      if (error) {
        setMessage(`Upload failed: ${error.message}`);
        return;
      }

      const fd = new FormData();
      fd.set("supplier_id", supplierId);
      fd.set("period_id", periodId);
      fd.set("storage_path", path);
      fd.set("file_name", file.name);
      startTransition(async () => {
        await action(fd); // reads and checks the file on the server, then moves to the next page
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
        <label htmlFor="file" className="label">
          Supplier statement file
        </label>
        <input
          ref={fileRef}
          id="file"
          type="file"
          accept=".pdf,.xlsx,.csv,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500">PDF (text-based), Excel .xlsx or CSV · up to 20 MB</p>
      </div>
      {message && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {message}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {uploading ? "Uploading…" : pending ? "Reading the file…" : "Upload and preview"}
      </button>
      <p className="text-xs text-slate-500">Nothing is imported yet. You will see a preview and checks first.</p>
    </form>
  );
}
