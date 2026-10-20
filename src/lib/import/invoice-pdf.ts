import { d, parseAmount, round2 } from "@/lib/money";
import { parseIsoDate } from "./dates";
import { emptyDocRow, type ParsedDocRow, type ParsedDocs } from "./doc-types";
import type { RowIssue } from "./types";

/**
 * Reader for bilingual (Arabic/English) ZATCA-style tax invoice PDFs, as issued by Saudi Vetonit (SAVETO):
 *
 *   Invoice Number / Invoice Date, P.O.NO, Order No | Delivery No | Delivery Date | Salesman No | Customer No,
 *   a table  P.CODE | DESCRIPTION | UN | U.PRICE | QTY | Taxable Amount | VAT Rate | Tax Amount | Total,
 *   and the totals block (Total Excluding VAT, Total VAT, Total Amount Due).
 *
 * It only looks at the English text; the Arabic is ignored. One PDF is one invoice (or credit note).
 * The printed totals are kept with every line so the importer can prove every line was read.
 */

const AMT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}`;
const ITEM_LINE = new RegExp(
  String.raw`^(\S+)\s+(.+?)\s+([A-Za-z]{1,5})\s+(${AMT})\s+(\d+(?:\.\d{1,4})?)\s+(${AMT})\s+(\d+(?:\.\d+)?)%\s+(${AMT})\s+(${AMT})$`,
);
const NUMBER_DATE_LINE = /^([A-Za-z0-9][A-Za-z0-9\-/]*)\s+(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/;
const LAST_AMT = new RegExp(String.raw`(${AMT})\s*$`);

const asciiOnly = (s: string) => s.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();

function lastAmount(line: string): string | null {
  const m = LAST_AMT.exec(line.trim());
  return m ? (parseAmount(m[1])?.toFixed(2) ?? null) : null;
}

export function isTaxInvoicePdf(lines: string[]): boolean {
  const head = lines.slice(0, 12).join(" ");
  return /Tax Invoice|Credit Note|Debit Note/i.test(head) && lines.some((l) => /P\.CODE\s+DESCRIPTION/i.test(l));
}

export function parseTaxInvoiceLines(lines: string[]): ParsedDocs {
  const warnings: string[] = [];
  const control: ParsedDocs["control"] = {};
  const tableStart = lines.findIndex((l) => /P\.CODE\s+DESCRIPTION/i.test(l));
  const totalsStart = lines.findIndex((l) => /^Total Excluding VAT/i.test(l.trim()));
  const head = tableStart >= 0 ? lines.slice(0, tableStart) : lines;

  // ---- header ----
  const title = lines.slice(0, 8).join(" ");
  const docType: "invoice" | "credit_note" = /Credit Note/i.test(title) ? "credit_note" : "invoice";

  let invoiceNumber: string | null = null;
  let invoiceDate: string | null = null;
  for (const l of head) {
    const m = NUMBER_DATE_LINE.exec(l.trim());
    if (m) {
      invoiceNumber = m[1];
      invoiceDate = parseIsoDate(m[2]);
      break;
    }
  }

  const sellerLine = head.slice(0, 4).join(" ").match(/\b(\d{15})\b/);
  if (sellerLine) control.sellerVat = sellerLine[1];
  for (const l of head) {
    const bv = /VAT Number:\s*(\d{15})/i.exec(l);
    if (bv) control.buyerVat = bv[1];
  }

  const poRefs: string[] = [];
  for (const l of head) {
    const m = /\bPO\s+([A-Za-z0-9][A-Za-z0-9\-/_.]*)/.exec(l);
    if (m && !poRefs.includes(m[1])) poRefs.push(m[1]);
  }

  let dnRefs: string[] = [];
  const delivIdx = head.findIndex((l) => /Order No\s+Delivery No/i.test(l));
  if (delivIdx >= 0 && head[delivIdx + 1]) {
    const tokens = head[delivIdx + 1].trim().split(/\s+/);
    const dateIdx = tokens.findIndex((t) => /^\d{4}-\d{2}-\d{2}$/.test(t));
    if (dateIdx > 1) {
      control.orderNo = tokens[0];
      dnRefs = tokens.slice(1, dateIdx).join(",").split(",").map((s) => s.trim()).filter(Boolean);
      const after = tokens.slice(dateIdx + 1);
      if (after.length >= 2) control.accountRef = after[after.length - 1];
    }
  }

  // ---- totals ----
  const tail = totalsStart >= 0 ? lines.slice(totalsStart) : [];
  let totalNet: string | null = null;
  let totalVat: string | null = null;
  let totalDue: string | null = null;
  let currency: string | null = null;
  let termsDays: number | null = null;
  for (const l of tail) {
    const t = l.trim();
    if (/^Total Excluding VAT/i.test(t)) totalNet = lastAmount(t);
    else if (/^Total Taxable Amount/i.test(t) && totalNet === null) totalNet = lastAmount(t);
    else if (/^Total VAT/i.test(t)) totalVat = lastAmount(t);
    else if (/^Total Amount Due/i.test(t)) {
      totalDue = lastAmount(t);
      const c = /\b([A-Z]{3})\s+\d/.exec(t);
      if (c) currency = c[1];
    }
    const terms = /Net\s+(\d+)\s+Days/i.exec(t);
    if (terms) termsDays = Number(terms[1]);
  }

  // ---- lines ----
  const rows: ParsedDocRow[] = [];
  if (tableStart >= 0) {
    const end = totalsStart >= 0 ? totalsStart : lines.length;
    let lineNo = 0;
    let rowNumber = 0;
    for (let i = tableStart + 1; i < end; i++) {
      const t = lines[i].trim();
      const m = ITEM_LINE.exec(t);
      if (m) {
        lineNo += 1;
        rowNumber += 1;
        const row = emptyDocRow("invoice", rowNumber, t);
        row.itemCode = m[1];
        row.description = m[2].trim();
        row.uom = m[3].toUpperCase();
        row.unitPrice = parseAmount(m[4])!.toFixed(4);
        row.qty = d(m[5]).toDecimalPlaces(3).toFixed(3);
        row.net = parseAmount(m[6])!.toFixed(2);
        row.vat = parseAmount(m[8])!.toFixed(2);
        row.gross = parseAmount(m[9])!.toFixed(2);
        row.lineNo = lineNo;
        rows.push(row);
      } else if (rows.length > 0) {
        // The second line of a description (the English part; the Arabic is dropped).
        const extra = asciiOnly(t);
        const last = rows[rows.length - 1];
        if (extra && !/^Total$/i.test(extra) && /[A-Za-z]/.test(extra)) {
          last.description = `${last.description} ${extra}`.trim();
          last.raw = `${last.raw} | ${t}`;
        }
      }
    }
  }

  // ---- header onto every line ----
  const headerTotals = {
    net: totalNet,
    vat: totalVat,
    gross: totalDue,
    paymentTermsDays: termsDays,
  };
  let dueDate: string | null = null;
  if (invoiceDate && termsDays !== null) {
    const dt = new Date(`${invoiceDate}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + termsDays);
    dueDate = dt.toISOString().slice(0, 10);
  }
  for (const r of rows) {
    r.docType = docType;
    r.docNumber = invoiceNumber;
    r.docDate = invoiceDate;
    r.dueDate = dueDate;
    r.currency = currency;
    r.poRefs = poRefs;
    r.dnRefs = dnRefs;
    r.header = headerTotals;
    const issues: RowIssue[] = [];
    if (!invoiceNumber) issues.push({ field: "doc_number", code: "missing_reference", message: "Invoice number was not found on the document.", severity: "error" });
    if (!invoiceDate) issues.push({ field: "doc_date", code: "invalid_date", message: "Invoice date was not found on the document.", severity: "error" });
    r.issues = issues;
  }

  if (rows.length === 0) warnings.push("No invoice lines were recognised in this PDF.");
  if (totalDue === null) warnings.push("The total amount due was not found, so the lines cannot be checked against the printed total.");
  if (poRefs.length === 0) warnings.push("No PO number was found on the invoice.");

  // Sanity: gross of lines vs printed total is checked by the importer; keep the rounding helper referenced.
  void round2;
  return { rows, control, warnings };
}
