import ExcelJS from "exceljs";
import { Readable } from "node:stream";

export type CellValue = string | number | boolean | Date | null;

export type Tabular = {
  sheetNames: string[];
  sheetName: string;
  /** All rows of the chosen sheet, 0-based; row 0 is spreadsheet row 1. */
  rows: CellValue[][];
};

/** Reduce any ExcelJS cell value (formula, rich text, hyperlink...) to a plain value. */
function plain(v: ExcelJS.CellValue): CellValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return plain(o.result as ExcelJS.CellValue); // formula
    if ("richText" in o && Array.isArray(o.richText)) {
      const t = (o.richText as { text: string }[]).map((r) => r.text).join("").trim();
      return t === "" ? null : t;
    }
    if ("text" in o) return plain(o.text as ExcelJS.CellValue); // hyperlink
    if ("error" in o) return null;
  }
  return String(v);
}

function detectDelimiter(buf: Buffer): string {
  const head = buf.subarray(0, 4096).toString("utf8").split(/\r?\n/).slice(0, 5).join("\n");
  const counts: [string, number][] = [
    [",", (head.match(/,/g) ?? []).length],
    [";", (head.match(/;/g) ?? []).length],
    ["\t", (head.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export async function readTabular(
  buf: Buffer,
  kind: "xlsx" | "csv",
  sheet?: string,
): Promise<Tabular> {
  const wb = new ExcelJS.Workbook();

  if (kind === "csv") {
    const text = buf.toString("utf8").replace(/^﻿/, "");
    await wb.csv.read(Readable.from([Buffer.from(text, "utf8")]), {
      parserOptions: { delimiter: detectDelimiter(buf), relax_column_count: true },
    } as never);
  } else {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  }

  const sheetNames = wb.worksheets.map((w) => w.name);
  const ws = (sheet ? wb.getWorksheet(sheet) : undefined) ?? wb.worksheets[0];
  if (!ws) return { sheetNames, sheetName: "", rows: [] };

  const rows: CellValue[][] = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const out: CellValue[] = [];
    for (let c = 1; c <= width; c++) out.push(plain(row.getCell(c).value));
    rows[rowNumber - 1] = out;
  });
  for (let i = 0; i < rows.length; i++) rows[i] ??= new Array(width).fill(null);

  return { sheetNames, sheetName: ws.name, rows };
}

/** First row (within the first 30) with at least 3 filled cells is assumed to hold the headers. 1-based. */
export function detectHeaderRow(rows: CellValue[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    if (rows[i].filter((c) => c !== null && String(c).trim() !== "").length >= 3) return i + 1;
  }
  return 1;
}

export function cellToText(c: CellValue): string {
  if (c === null) return "";
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c);
}
