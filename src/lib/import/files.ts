import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "@/lib/forms";

export type FileKind = "pdf" | "xlsx" | "csv";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const CONTENT_TYPES: Record<FileKind, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Decide the file type from the name AND the file's first bytes, so a renamed file is not trusted. */
export function detectKind(fileName: string, buf: Buffer): FileKind {
  const ext = (fileName.toLowerCase().split(".").pop() ?? "").trim();
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isOle = buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;

  if (ext === "xls" || isOle) {
    throw new UserError(
      "Old Excel files (.xls) are not supported. Open the file in Excel, choose Save As > Excel Workbook (.xlsx) or CSV, and upload that instead.",
    );
  }
  if (ext === "pdf") {
    if (!isPdf) throw new UserError("This file is named .pdf but is not a valid PDF.");
    return "pdf";
  }
  if (ext === "xlsx") {
    if (!isZip) throw new UserError("This file is named .xlsx but is not a valid Excel workbook.");
    return "xlsx";
  }
  if (ext === "csv" || ext === "txt") {
    if (isPdf || isZip) throw new UserError("This file is named .csv but its contents are not plain text.");
    return "csv";
  }
  throw new UserError("Unsupported file type. Upload a PDF, an Excel workbook (.xlsx) or a CSV file.");
}

export async function downloadImportFile(supabase: SupabaseClient, path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from("imports").download(path);
  if (error || !data) throw new UserError("The uploaded file could not be read back. Please upload it again.");
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new UserError("The file is larger than 20 MB.");
  return buf;
}
