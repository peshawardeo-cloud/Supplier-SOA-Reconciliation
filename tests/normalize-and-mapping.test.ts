import { describe, expect, it } from "vitest";
import { normalizeDocNumber } from "@/lib/reconcile/normalize";
import { classifyEntryType, guessSoaMapping, rowsToSoa, type SoaMapping } from "@/lib/import/soa-mapping";
import { parseDayFirstDate, parseIsoDate } from "@/lib/import/dates";

describe("normalizeDocNumber", () => {
  it("ignores case, spaces and separators", () => {
    expect(normalizeDocNumber(" inv-2026/0418 ")).toBe("INV20260418");
  });
  it("converts Arabic-Indic digits", () => {
    expect(normalizeDocNumber("INV٠٤١٨")).toBe("INV0418");
  });
  it("can strip configured prefixes and leading zeros", () => {
    const rules = { strip_prefixes: ["INV"], strip_leading_zeros: true };
    expect(normalizeDocNumber("INV-0418", rules)).toBe("418");
    expect(normalizeDocNumber("0418", rules)).toBe("418");
  });
  it("never strips a number down to nothing", () => {
    expect(normalizeDocNumber("INV", { strip_prefixes: ["INV"] })).toBe("INV");
    expect(normalizeDocNumber("000", { strip_leading_zeros: true })).toBe("0");
  });
  it("keeps document suffixes such as RI", () => {
    expect(normalizeDocNumber("2020752RI")).toBe("2020752RI");
  });
});

describe("dates", () => {
  it("parses day-first and rejects impossible dates", () => {
    expect(parseDayFirstDate("03/04/2026")).toBe("2026-04-03");
    expect(parseDayFirstDate("31/02/2026")).toBeNull();
    expect(parseDayFirstDate("13/13/2026")).toBeNull();
  });
  it("parses ISO datetimes", () => {
    expect(parseIsoDate("2026-05-04 19:31:59")).toBe("2026-05-04");
  });
});

describe("spreadsheet mapping", () => {
  it("guesses columns from common header names", () => {
    const g = guessSoaMapping(["Date", "Invoice No", "Type", "Description", "Debit", "Credit", "Balance"]);
    expect(g).toMatchObject({ doc_date: 0, doc_number: 1, entry_type: 2, description: 3, debit: 4, credit: 5 });
    expect(g.amount).toBeUndefined();
  });

  it("classifies entry types", () => {
    expect(classifyEntryType("Credit Memo")).toBe("credit_note");
    expect(classifyEntryType("Hand Held Cash Order")).toBe("payment");
    expect(classifyEntryType("Tax Invoice")).toBe("invoice");
    expect(classifyEntryType("???")).toBeNull();
  });

  const headers = ["Date", "Ref", "Type", "Debit", "Credit"];
  const base: SoaMapping = {
    headerRow: 1,
    columns: { doc_date: 0, doc_number: 1, entry_type: 2, debit: 3, credit: 4 },
    dateFormat: "dmy",
    amountMode: "debit_credit",
    signedPositive: "debit",
    defaultType: "invoice",
  };

  it("converts rows with debit and credit columns", () => {
    const rows = rowsToSoa(
      [
        ["05/01/2026", "INV-1", "Invoice", "1,150.00", null],
        ["06/01/2026", "CN-1", "Credit Note", null, "150.00"],
        ["07/01/2026", "PAY-1", "Receipt", null, 500],
      ],
      headers,
      base,
      2,
    );
    expect(rows.map((r) => [r.entryType, r.debit, r.credit])).toEqual([
      ["invoice", "1150.00", "0.00"],
      ["credit_note", "0.00", "150.00"],
      ["payment", "0.00", "500.00"],
    ]);
    expect(rows[0].rowNumber).toBe(2);
    expect(rows.every((r) => r.issues.length === 0)).toBe(true);
  });

  it("rejects bad dates, missing numbers and both-sided rows", () => {
    const rows = rowsToSoa(
      [
        ["99/99/2026", "INV-2", "Invoice", "10", null],
        ["05/01/2026", null, "Invoice", "10", null],
        ["05/01/2026", "INV-3", "Invoice", "10", "10"],
      ],
      headers,
      base,
      2,
    );
    expect(rows[0].issues.map((i) => i.code)).toContain("invalid_date");
    expect(rows[1].issues.map((i) => i.code)).toContain("missing_reference");
    expect(rows[2].issues.map((i) => i.code)).toContain("both_sides");
  });

  it("supports a single signed amount column", () => {
    const m: SoaMapping = { ...base, columns: { doc_date: 0, doc_number: 1, amount: 3 }, amountMode: "signed", signedPositive: "debit" };
    const rows = rowsToSoa(
      [
        ["05/01/2026", "A", null, "100.00"],
        ["06/01/2026", "B", null, "(40.00)"],
      ],
      headers,
      m,
      2,
    );
    expect(rows[0].debit).toBe("100.00");
    expect(rows[1].credit).toBe("40.00");
    expect(rows[1].entryType).toBe("payment");
  });

  it("skips fully blank rows", () => {
    expect(rowsToSoa([[null, null, null, null, null]], headers, base, 2)).toHaveLength(0);
  });
});
