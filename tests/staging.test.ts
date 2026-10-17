import { describe, expect, it } from "vitest";
import { buildStagingRows, checkSupplierIdentity } from "@/lib/import/staging";
import type { ParsedSoaRow } from "@/lib/import/types";

const row = (n: number, over: Partial<ParsedSoaRow> = {}): ParsedSoaRow => ({
  rowNumber: n,
  raw: `line ${n}`,
  entryType: "invoice",
  docDate: "2026-09-05",
  docNumber: `INV-${n}`,
  accountRef: "70001",
  deliveryRef: null,
  poRef: null,
  dueDate: null,
  currency: null,
  description: null,
  debit: "100.00",
  credit: "0.00",
  issues: [],
  ...over,
});

const ctx = (existing: Record<string, string> = {}) => ({
  rules: { strip_prefixes: [] },
  supplier: { account_ref: "70001", currency: "SAR" },
  period: { start: "2026-09-01", end: "2026-09-30" },
  existing: new Map(Object.entries(existing)),
});

describe("buildStagingRows", () => {
  it("marks clean rows valid, rows with errors as error", () => {
    const bad = row(2, { issues: [{ field: "doc_date", code: "invalid_date", message: "bad", severity: "error" }] });
    const { records, counts } = buildStagingRows([row(1), bad], ctx());
    expect(records.map((r) => r.status)).toEqual(["valid", "error"]);
    expect(counts).toEqual({ valid: 1, errors: 1, duplicates: 0 });
  });

  it("flags documents already imported in the period, keyed by normalised number", () => {
    const { records } = buildStagingRows([row(1, { docNumber: "inv 1" })], ctx({ "invoice|INV1": "entry-id" }));
    expect(records[0].status).toBe("duplicate");
    expect(records[0].duplicate_of).toBe("entry-id");
  });

  it("flags repeats inside the same file but keeps the first", () => {
    const { records } = buildStagingRows([row(1, { docNumber: "A1" }), row(2, { docNumber: "a-1" })], ctx());
    expect(records.map((r) => r.status)).toEqual(["valid", "duplicate"]);
    expect(records[1].issues.map((i) => i.code)).toContain("duplicate_in_file");
  });

  it("treats the same number under a different type as a different document", () => {
    const { records } = buildStagingRows(
      [row(1, { docNumber: "X1" }), row(2, { docNumber: "X1", entryType: "credit_note", debit: "0.00", credit: "10.00" })],
      ctx(),
    );
    expect(records.every((r) => r.status === "valid")).toBe(true);
  });

  it("warns on a different account number but still allows the row", () => {
    const { records } = buildStagingRows([row(1, { accountRef: "99999" })], ctx());
    expect(records[0].status).toBe("valid");
    expect(records[0].issues.map((i) => i.code)).toContain("account_mismatch");
  });

  it("counts rows dated outside the period and gives identical rows an identical fingerprint", () => {
    const a = buildStagingRows([row(1, { docDate: "2025-01-01" })], ctx());
    expect(a.outsidePeriod).toBe(1);
    const b = buildStagingRows([row(1), row(9, { docNumber: "INV-1" })], ctx());
    expect(b.records[0].mapped.row_fingerprint).toBe(b.records[1].mapped.row_fingerprint);
  });
});

describe("checkSupplierIdentity", () => {
  const supplier = { name: "Saudi Vetonit Co. Ltd.", code: "SAVETO", account_ref: "38609" };

  it("matches on name, code or alias", () => {
    expect(checkSupplierIdentity({ supplierName: "Saudi Vetonit Co.Ltd.(SAVETO)" }, supplier, []).name_match).toBe(true);
    expect(checkSupplierIdentity({ supplierName: "Some Other Company" }, supplier, []).name_match).toBe(false);
    expect(checkSupplierIdentity({ supplierName: "Weber Trading" }, supplier, ["Weber Trading"]).name_match).toBe(true);
  });

  it("compares the account number only when both sides have one", () => {
    expect(checkSupplierIdentity({ accountRef: "38609" }, supplier, []).account_match).toBe(true);
    expect(checkSupplierIdentity({ accountRef: "11111" }, supplier, []).account_match).toBe(false);
    expect(checkSupplierIdentity({ accountRef: "38609" }, { ...supplier, account_ref: null }, []).account_match).toBeNull();
    expect(checkSupplierIdentity({}, supplier, []).name_match).toBeNull();
  });
});
