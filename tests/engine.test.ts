import { describe, it, expect } from "vitest";
import { reconcile, numberSimilarity, suffixRelated, type EngineInput } from "@/lib/reconcile/engine";

const settings = { vatRate: "0.15", amountToleranceAbs: "0.05", amountTolerancePct: "0", qtyTolerance: "0", dateWindowDays: 7, rules: {} };
const base = (): EngineInput => ({
  period: { start: "2026-01-01", end: "2026-09-30", reportedOpening: "0", reportedClosing: null },
  settings, soa: [], invoices: [], payments: [], pos: [], dns: [], paymentAllocations: [], creditAllocations: [],
  existingMatches: [], existingLinks: [],
});
const soaInv = (id: string, no: string, amt: string, date = "2026-05-04", extra = {}) =>
  ({ id, type: "invoice" as const, docNumber: no, docDate: date, debit: amt, credit: "0", ...extra });
const inv = (id: string, no: string, net: string, vat: string, gross: string, extra = {}) =>
  ({ id, docType: "invoice" as const, number: no, date: "2026-05-04", net, vat, gross, vatCalculated: false, poRefs: [], dnRefs: [], lines: [], ...extra });

describe("similarity helpers", () => {
  it("detects close numbers but not unrelated ones", () => {
    expect(numberSimilarity("2020752RI", "2020752RI")).toBeTruthy();
    expect(numberSimilarity("2020752RI", "2020725RI")).toMatch(/one character/); // swapped digits
    expect(numberSimilarity("INV0418", "0418")).toBeNull(); // too short to trust
    expect(numberSimilarity("INV00418", "BILL418")).toBeNull();
    expect(numberSimilarity("INV00041800", "00041800")).toMatch(/same digits/);
    expect(numberSimilarity("2020752RI", "2020999RI")).toBeNull();
  });
  it("suffix relation needs 5+ characters", () => {
    expect(suffixRelated("CRSAJCDCPRO200196", "200196")).toBe(true);
    expect(suffixRelated("ABC123", "123")).toBe(false);
  });
});

describe("matching", () => {
  it("exact numbers are auto-confirmed with exact origin", () => {
    const i = base();
    i.soa = [soaInv("s1", "2020752-ri", "12454.50")];
    i.invoices = [inv("i1", "2020752RI", "10830.00", "1624.50", "12454.50")];
    const r = reconcile(i);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ origin: "exact", state: "confirmed", confidence: 100 });
    expect(r.findings.filter((f) => f.type !== "invoice_no_po" && f.type !== "invoice_no_dn")).toHaveLength(0);
  });

  it("amount alone never matches or suggests", () => {
    const i = base();
    i.soa = [soaInv("s1", "AAAA1111", "500.00")];
    i.invoices = [inv("i1", "ZZZZ9999", "434.78", "65.22", "500.00")];
    const r = reconcile(i);
    expect(r.matches).toHaveLength(0);
    const types = r.findings.map((f) => f.type);
    expect(types).toContain("soa_without_invoice");
    expect(types).toContain("invoice_missing_from_soa");
  });

  it("a similar number with two supporting facts is only suggested", () => {
    const i = base();
    i.soa = [soaInv("s1", "2020725RI", "12454.50")];
    i.invoices = [inv("i1", "2020752RI", "10830.00", "1624.50", "12454.50")];
    const r = reconcile(i);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ origin: "suggested", state: "pending" });
    expect(r.findings.some((f) => f.type === "manual_review")).toBe(true);
    expect(r.findings.some((f) => f.type === "soa_without_invoice")).toBe(false);
  });

  it("a similar number with only one supporting fact is not suggested", () => {
    const i = base();
    i.soa = [soaInv("s1", "2020725RI", "999.00", "2026-01-01")];
    i.invoices = [inv("i1", "2020752RI", "10830.00", "1624.50", "12454.50")];
    expect(reconcile(i).matches).toHaveLength(0);
  });

  it("a rejected suggestion is not proposed again", () => {
    const i = base();
    i.soa = [soaInv("s1", "2020725RI", "12454.50")];
    i.invoices = [inv("i1", "2020752RI", "10830.00", "1624.50", "12454.50")];
    i.existingMatches = [{ soaEntryId: "s1", invoiceId: "i1", paymentId: null, state: "rejected" }];
    expect(reconcile(i).matches).toHaveLength(0);
  });

  it("credit notes only match credit notes", () => {
    const i = base();
    i.soa = [{ id: "s1", type: "credit_note", docNumber: "CN1", docDate: "2026-05-04", debit: "0", credit: "115.00" }];
    i.invoices = [inv("i1", "CN1", "100", "15", "115")]; // invoice with the same number is a different document
    expect(reconcile(i).matches).toHaveLength(0);
  });

  it("reports amount mismatches with the calculation", () => {
    const i = base();
    i.soa = [soaInv("s1", "I1", "1150.00")];
    i.invoices = [inv("i1", "I1", "1000", "150", "1100.00")];
    const f = reconcile(i).findings.find((x) => x.type === "soa_amount_mismatch")!;
    expect(f.expected_amount).toBe("1100.00");
    expect(f.actual_amount).toBe("1150.00");
    expect(f.calculation!.result).toBe("50.00");
  });

  it("differences inside the tolerance are not reported", () => {
    const i = base();
    i.soa = [soaInv("s1", "I1", "1100.03")];
    i.invoices = [inv("i1", "I1", "956.52", "143.48", "1100.00")];
    expect(reconcile(i).findings.some((x) => x.type === "soa_amount_mismatch")).toBe(false);
  });

  it("matches payments by reference and flags unmatched ones on both sides", () => {
    const i = base();
    i.soa = [
      { id: "p1", type: "payment", docNumber: "PAY-001", docDate: "2026-06-01", debit: "0", credit: "500.00" },
      { id: "p2", type: "payment", docNumber: "PAY-777", docDate: "2026-06-02", debit: "0", credit: "50.00" },
    ];
    i.payments = [
      { id: "a", ref: "PAY001", date: "2026-06-01", amount: "500.00" },
      { id: "b", ref: "PAY-900", date: "2026-06-03", amount: "20.00" },
    ];
    const r = reconcile(i);
    expect(r.matches).toHaveLength(1);
    const types = r.findings.map((f) => f.type);
    expect(types).toContain("soa_payment_without_internal");
    expect(types).toContain("payment_not_in_soa");
  });
});

describe("documents: PO, DN, VAT, duplicates", () => {
  it("links an invoice to a PO by exact and by suffix reference", () => {
    const i = base();
    i.invoices = [inv("i1", "I1", "100", "15", "115", { poRefs: ["CRSA-JCDC-PRO-200196"] }), inv("i2", "I2", "100", "15", "115", { poRefs: ["P-5"] })];
    i.pos = [{ id: "po1", number: "200196", date: "2026-04-01", lines: [] }, { id: "po2", number: "P5", date: "2026-04-01", lines: [] }];
    const r = reconcile(i);
    const l1 = r.links.find((l) => l.invoice_id === "i1")!;
    expect(l1).toMatchObject({ origin: "suggested", state: "pending" });
    expect(r.links.find((l) => l.invoice_id === "i2")).toMatchObject({ origin: "exact", state: "confirmed" });
  });

  it("flags quantity and price differences against the PO", () => {
    const i = base();
    i.invoices = [inv("i1", "I1", "230", "34.5", "264.5", { poRefs: ["P1"], lines: [{ itemCode: "A1", qty: "10", net: "230" }] })];
    i.pos = [{ id: "po1", number: "P1", date: "2026-04-01", net: "200", lines: [{ itemCode: "A1", qty: "8", unitPrice: "20" }] }];
    const types = reconcile(i).findings.map((f) => f.type);
    expect(types).toContain("po_invoice_qty");
    expect(types).toContain("po_invoice_amount");
  });

  it("flags invoiced quantity above delivered quantity", () => {
    const i = base();
    i.invoices = [inv("i1", "I1", "100", "15", "115", { dnRefs: ["D1"], lines: [{ itemCode: "A1", qty: "10", net: "100" }] })];
    i.dns = [{ id: "d1", number: "D1", date: "2026-05-01", poRefs: [], lines: [{ itemCode: "A1", qty: "6" }] }];
    expect(reconcile(i).findings.some((f) => f.type === "invoice_qty_vs_delivery")).toBe(true);
  });

  it("flags VAT that does not follow the rate, but not VAT we calculated ourselves", () => {
    const i = base();
    i.invoices = [inv("i1", "I1", "1000", "100", "1100"), inv("i2", "I2", "1000", "100", "1100", { vatCalculated: true })];
    const v = reconcile(i).findings.filter((f) => f.type === "vat_mismatch");
    expect(v).toHaveLength(1);
    expect(v[0].expected_amount).toBe("150.00");
  });

  it("flags potential duplicate invoices", () => {
    const i = base();
    i.invoices = [inv("i1", "2020752RI", "100", "15", "115", { poRefs: ["P1"] }), inv("i2", "2020725RI", "100", "15", "115", { poRefs: ["P1"] })];
    expect(reconcile(i).findings.some((f) => f.type === "duplicate_invoice")).toBe(true);
  });

  it("flags unallocated payments as refund candidates", () => {
    const i = base();
    i.payments = [{ id: "p", ref: "PAY1", date: "2026-06-01", amount: "100.00" }];
    i.paymentAllocations = [{ paymentId: "p", invoiceId: "x", amount: "40.00" }];
    const r = reconcile(i);
    expect(r.findings.find((f) => f.type === "payment_unallocated")!.calculation!.result).toBe("60.00");
    expect(r.summary.refund_candidates).toBe(1);
  });
});

describe("balance waterfall", () => {
  it("explains the whole difference by buckets", () => {
    const i = base();
    i.period.reportedClosing = "13000.00";
    i.soa = [
      soaInv("s1", "I1", "1000.00"),             // matched exactly
      soaInv("s2", "I2", "2000.00"),             // statement only
      soaInv("s3", "I3", "1150.00"),             // matched, amount differs (we have 1100)
      { id: "s4", type: "payment", docNumber: "PAY1", docDate: "2026-06-01", debit: "0", credit: "500.00" }, // statement-only payment
    ];
    i.invoices = [inv("a", "I1", "869.57", "130.43", "1000.00"), inv("b", "I3", "956.52", "143.48", "1100.00"), inv("c", "I9", "434.78", "65.22", "500.00")];
    const r = reconcile(i);
    // reported from entries = 1000+2000+1150-500 = 3650 ; internal = 1000+1100+500 = 2600
    expect(r.waterfall.internalClosing).toBe("2600.00");
    const get = (k: string) => r.waterfall.buckets.find((b) => b.key === k)?.amount;
    expect(get("soa_only")).toBe("2000.00");
    expect(get("amount_diff")).toBe("50.00");
    expect(get("internal_only")).toBe("-500.00");
    expect(get("soa_payment_only")).toBe("-500.00");
    // 13000 - 2600 = 10400 ; explained = 2000+50-500-500 = 1050 ; unexplained = 9350 (printed closing disagrees with lines)
    expect(r.waterfall.difference).toBe("10400.00");
    expect(r.waterfall.unexplained).toBe("9350.00");
  });

  it("zero unexplained when the statement lines add up to its closing balance", () => {
    const i = base();
    i.period.reportedClosing = "1000.00";
    i.soa = [soaInv("s1", "I1", "1000.00")];
    i.invoices = [inv("a", "I1", "869.57", "130.43", "1000.00")];
    const r = reconcile(i);
    expect(r.waterfall.difference).toBe("0.00");
    expect(r.findings.some((f) => f.type === "balance_difference")).toBe(false);
  });

  it("is deterministic", () => {
    const i = base();
    i.soa = [soaInv("s1", "2020725RI", "100"), soaInv("s2", "2020752RI", "100")];
    i.invoices = [inv("a", "2020752RI", "86.96", "13.04", "100"), inv("b", "2020725RR", "86.96", "13.04", "100")];
    expect(JSON.stringify(reconcile(i))).toBe(JSON.stringify(reconcile(i)));
  });
});
