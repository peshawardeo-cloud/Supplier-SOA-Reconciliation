import { describe, expect, it } from "vitest";
import { compareSoaControl, computeSoaTotals, parseSoaLines } from "@/lib/import/soa-text";

// Fictional statement in the same layout as a real supplier PDF.
const LINES = [
  "A.USER Example Building Materials Co.(EXMPL) 08/10/2026 10:02:16",
  "Statement of Account (Granparent/Parent/Child) Page - 1",
  "Date From: 01/01/2026 Date To: 30/09/2026",
  "G/L Address Invoice Invoice Type Delivery Amount Receipt Check Transaction Explanation",
  "Date Number Number Number Gross Number Amount Write Off Amount -Remark-",
  "05/01/2026 70001 0 Hand Held Cash Order 9001RVSF0000011 5,000.00 BK1234 / O2N",
  "06/01/2026 70001 1000001RI Invoice 3000001 11,500.00",
  "07/01/2026 70001 1000002RI Invoice 3000002 2,300.50",
  "09/01/2026 70001 90001RM Credit Memo 3000002 1,150.25-",
  "10/01/2026 70001 90002RM Credit Memo .02-",
  "31/02/2026 70001 1000003RI Invoice 3000003 100.00",
  "12/01/2026 70001 1000004RI Invoice ??? 100.00",
  '" This document is not final and shall not be considered or used in front of Judicial authorities "',
  "12,650.23 5,000.00",
  "GRANDPARENT: 70001 EXAMPLE JV 4 1 7,650.23 7,650.23",
];

describe("parseSoaLines", () => {
  const parsed = parseSoaLines(LINES);
  const byNo = (n: string) => parsed.rows.find((r) => r.docNumber === n)!;

  it("reads the statement header and printed totals", () => {
    expect(parsed.control.supplierName).toBe("Example Building Materials Co.(EXMPL)");
    expect(parsed.control.dateFrom).toBe("2026-01-01");
    expect(parsed.control.dateTo).toBe("2026-09-30");
    expect(parsed.control.accountRef).toBe("70001");
    expect(parsed.control.closingBalance).toBe("7650.23");
    expect(parsed.control.invoiceCount).toBe(4);
    expect(parsed.control.receiptCount).toBe(1);
  });

  it("classifies invoices as debits and keeps delivery references", () => {
    const r = byNo("1000001RI");
    expect(r.entryType).toBe("invoice");
    expect(r.debit).toBe("11500.00");
    expect(r.credit).toBe("0.00");
    expect(r.deliveryRef).toBe("3000001");
    expect(r.docDate).toBe("2026-01-06");
  });

  it("treats credit memos (trailing minus) as credits, with or without a delivery number", () => {
    expect(byNo("90001RM").credit).toBe("1150.25");
    expect(byNo("90001RM").deliveryRef).toBe("3000002");
    expect(byNo("90002RM").credit).toBe("0.02");
    expect(byNo("90002RM").deliveryRef).toBeNull();
  });

  it("treats cash orders as payments identified by their receipt number", () => {
    const r = byNo("9001RVSF0000011");
    expect(r.entryType).toBe("payment");
    expect(r.credit).toBe("5000.00");
    expect(r.description).toContain("BK1234");
  });

  it("rejects impossible dates and unrecognised lines instead of dropping them", () => {
    expect(byNo("1000003RI").issues.map((i) => i.code)).toContain("invalid_date");
    const unknown = parsed.rows.find((r) => r.raw.includes("???"))!;
    expect(unknown.issues[0].code).toBe("unrecognized_line");
    expect(parsed.warnings).toHaveLength(1);
  });

  it("ignores page headers, column titles and the disclaimer", () => {
    expect(parsed.rows).toHaveLength(7);
  });
});

describe("control totals", () => {
  it("matches the statement's own figures when parsing is complete", () => {
    const good = parseSoaLines(LINES.filter((l) => !l.startsWith("31/02") && !l.includes("???")));
    const checks = compareSoaControl(good.control, good.rows);
    expect(checks.length).toBe(5);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(computeSoaTotals(good.rows).balance.toFixed(2)).toBe("7650.23");
  });

  it("flags a mismatch when rows are missing", () => {
    const missing = parseSoaLines(LINES.filter((l) => !l.includes("1000002RI")));
    const checks = compareSoaControl(missing.control, missing.rows);
    expect(checks.some((c) => !c.ok)).toBe(true);
  });
});
