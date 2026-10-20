import ExcelJS from "exceljs";

export type Col = { header: string; key: string; width?: number; type?: "text" | "money" | "date" | "int" | "qty" };

const MONEY = '#,##0.00;[Red]-#,##0.00';

/** Text that starts with = + - @ would be run as a formula by Excel; make it plain text instead. */
export function safeText(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function toCell(v: unknown, type: Col["type"]): string | number | Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (type === "money" || type === "qty") {
    const n = Number(v);
    return Number.isFinite(n) ? n : safeText(v);
  }
  if (type === "int") {
    const n = Number(v);
    return Number.isFinite(n) ? n : safeText(v);
  }
  if (type === "date") {
    const dt = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(dt.getTime()) ? safeText(v) : dt;
  }
  return safeText(v);
}

export function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? (c.type === "money" ? 16 : c.type === "date" ? 12 : 22) }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
  for (const r of rows) {
    const row = ws.addRow(Object.fromEntries(cols.map((c) => [c.key, toCell(r[c.key], c.type)])));
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.type === "money") cell.numFmt = MONEY;
      else if (c.type === "date") cell.numFmt = "dd/mm/yyyy";
      else if (c.type === "qty") cell.numFmt = "#,##0.###";
    });
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

export function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Supplier SOA Reconciliation";
  wb.created = new Date();
  return wb;
}

export async function workbookResponse(wb: ExcelJS.Workbook, fileName: string) {
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
