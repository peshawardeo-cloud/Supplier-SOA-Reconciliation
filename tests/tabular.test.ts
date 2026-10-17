import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { detectHeaderRow, readTabular } from "@/lib/import/tabular";

describe("readTabular", () => {
  it("reads an .xlsx with a title block above the headers, dates and formulas", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Example Supplier Statement"]);
    ws.addRow([]);
    ws.addRow(["Date", "Invoice No", "Debit", "Credit"]);
    ws.addRow([new Date(Date.UTC(2026, 0, 5)), "INV-1", 1150, null]);
    ws.addRow([new Date(Date.UTC(2026, 0, 6)), "PAY-1", null, { formula: "A1", result: 500 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const t = await readTabular(buf, "xlsx");
    expect(t.sheetNames).toEqual(["Statement"]);
    expect(detectHeaderRow(t.rows)).toBe(3);
    expect(t.rows[2]).toEqual(["Date", "Invoice No", "Debit", "Credit"]);
    expect((t.rows[3][0] as Date).toISOString().slice(0, 10)).toBe("2026-01-05");
    expect(t.rows[3][2]).toBe(1150);
    expect(t.rows[4][3]).toBe(500);
  });

  it("reads CSV, including semicolon-delimited files with a BOM", async () => {
    const csv = "﻿Date;Ref;Debit;Credit\n05/01/2026;INV-1;1.150,00;\n";
    const t = await readTabular(Buffer.from(csv, "utf8"), "csv");
    expect(t.rows[0]).toEqual(["Date", "Ref", "Debit", "Credit"]);
    expect(t.rows[1][1]).toBe("INV-1");
  });
});
