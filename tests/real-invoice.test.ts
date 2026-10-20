import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { extractPdfLines } from "@/lib/import/pdf";
import { isTaxInvoicePdf, parseTaxInvoiceLines } from "@/lib/import/invoice-pdf";
import { buildDocStagingRows } from "@/lib/import/doc-staging";

const path = process.env.REAL_INVOICE_PDF;
describe.skipIf(!path || !existsSync(path))("real Saveto invoice PDF", () => {
  it("is read, passes its printed-total check and stages cleanly", async () => {
    const lines = await extractPdfLines(new Uint8Array(readFileSync(path!)));
    expect(isTaxInvoicePdf(lines)).toBe(true);
    const parsed = parseTaxInvoiceLines(lines);
    const r = buildDocStagingRows("invoice", parsed.rows, { rules: {}, supplier: { vat_number: null, currency: "SAR" }, existing: new Set(), control: parsed.control });
    console.log(JSON.stringify({ control: parsed.control, rows: parsed.rows.length, counts: r.counts, docs: r.documents, first: r.records[0]?.mapped, issues: r.records.flatMap((x) => x.issues) }, null, 1));
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(r.counts.errors).toBe(0);
    expect(r.documents).toBe(1);
  });
});
