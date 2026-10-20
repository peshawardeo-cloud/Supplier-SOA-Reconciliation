import { describe, it, expect } from "vitest";
import { buildDocStagingRows } from "@/lib/import/doc-staging";
import { emptyDocRow, type ParsedDocRow } from "@/lib/import/doc-types";

const ctx = (over = {}) => ({ rules: {}, supplier: { vat_number: "300000000000003", currency: "SAR" }, existing: new Set<string>(), ...over });
const inv = (n: number, no: string, gross: string, extra: Partial<ParsedDocRow> = {}): ParsedDocRow => ({
  ...emptyDocRow("invoice", n, "{}"), docNumber: no, docDate: "2026-05-04", net: gross, vat: "0.00", gross, qty: "1.000", ...extra,
});

describe("document staging", () => {
  it("groups lines into one document and counts documents", () => {
    const r = buildDocStagingRows("invoice", [inv(2, "I1", "10.00"), inv(3, "I1", "5.00"), inv(4, "I2", "1.00")], ctx());
    expect(r.documents).toBe(2);
    expect(r.counts.valid).toBe(3);
  });
  it("an error on one line rejects the whole document, not others", () => {
    const bad = inv(3, "I1", "5.00", { issues: [{ field: "qty", code: "x", message: "bad", severity: "error" }] });
    const r = buildDocStagingRows("invoice", [inv(2, "I1", "10.00"), bad, inv(4, "I2", "1.00")], ctx());
    expect(r.records.map((x) => x.status)).toEqual(["error", "error", "valid"]);
  });
  it("marks already-imported documents as duplicates", () => {
    const r = buildDocStagingRows("invoice", [inv(2, "I-1", "10.00")], ctx({ existing: new Set(["invoice|I1"]) }));
    expect(r.records[0].status).toBe("duplicate");
  });
  it("credit note with the same number is not a duplicate of the invoice", () => {
    const r = buildDocStagingRows("invoice", [inv(2, "I1", "10.00", { docType: "credit_note" })], ctx({ existing: new Set(["invoice|I1"]) }));
    expect(r.records[0].status).toBe("valid");
  });
  it("rejects a PDF invoice whose lines do not add up to the printed total", () => {
    const header = { net: null, vat: null, gross: "20.00", paymentTermsDays: null };
    const r = buildDocStagingRows("invoice", [inv(2, "I1", "10.00", { header }), inv(3, "I1", "5.00", { header })], ctx());
    expect(r.counts.errors).toBe(2);
    expect(r.records[0].issues.some((i) => /printed on the document/.test(i.message))).toBe(true);
  });
  it("rejects a document from a different seller", () => {
    const r = buildDocStagingRows("invoice", [inv(2, "I1", "10.00")], ctx({ control: { sellerVat: "399999999999993" } }));
    expect(r.records[0].status).toBe("error");
  });
  it("lines of one document with different dates are rejected", () => {
    const r = buildDocStagingRows("invoice", [inv(2, "I1", "10.00"), inv(3, "I1", "5.00", { docDate: "2026-05-05" })], ctx());
    expect(r.counts.errors).toBe(2);
  });
  it("flags repeated payments in one file", () => {
    const p = (n: number): ParsedDocRow => ({ ...emptyDocRow("payment", n, "{}"), docNumber: "PAY1", docDate: "2026-06-01", gross: "100.00" });
    const r = buildDocStagingRows("payment", [p(2), p(3)], ctx());
    expect(r.records.map((x) => x.status)).toEqual(["valid", "duplicate"]);
  });
});
