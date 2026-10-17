import { d, parseAmount } from "@/lib/money";
import { parseDayFirstDate, parseIsoDate } from "./dates";
import { cellToText, type CellValue } from "./tabular";
import type { ParsedSoaRow, RowIssue, SoaEntryType } from "./types";

export type SoaField =
  | "doc_date"
  | "doc_number"
  | "entry_type"
  | "description"
  | "debit"
  | "credit"
  | "amount"
  | "delivery_ref"
  | "po_ref"
  | "due_date"
  | "currency"
  | "account_ref";

export const SOA_FIELDS: { key: SoaField; label: string; hint?: string }[] = [
  { key: "doc_date", label: "Document date (required)" },
  { key: "doc_number", label: "Document / invoice number (required)" },
  { key: "entry_type", label: "Entry type", hint: "Invoice, credit memo, payment... (optional)" },
  { key: "debit", label: "Debit (increases what we owe)" },
  { key: "credit", label: "Credit (reduces what we owe)" },
  { key: "amount", label: "Single amount column", hint: "Use instead of debit/credit" },
  { key: "description", label: "Description / remarks" },
  { key: "delivery_ref", label: "Delivery note number" },
  { key: "po_ref", label: "PO number" },
  { key: "due_date", label: "Due date" },
  { key: "currency", label: "Currency" },
  { key: "account_ref", label: "Account number" },
];

export type SoaMapping = {
  headerRow: number; // 1-based
  columns: Partial<Record<SoaField, number>>; // 0-based column index
  dateFormat: "dmy" | "mdy" | "iso";
  amountMode: "debit_credit" | "signed";
  /** For a single signed amount column: does a positive number increase what we owe (debit) or reduce it (credit)? */
  signedPositive: "debit" | "credit";
  defaultType: SoaEntryType;
  sheet?: string;
};

const SYNONYMS: Record<SoaField, string[]> = {
  doc_date: ["date", "docdate", "documentdate", "invoicedate", "postingdate", "gldate", "transactiondate", "trxdate", "entrydate"],
  doc_number: ["invoice", "invoiceno", "invoicenumber", "invoicenum", "documentno", "documentnumber", "docno", "docnumber", "reference", "ref", "refno", "voucher", "number", "transactionno"],
  entry_type: ["type", "documenttype", "doctype", "transactiontype", "invoicetype", "trxtype"],
  description: ["description", "details", "narration", "remarks", "remark", "explanation", "particulars", "notes"],
  debit: ["debit", "dr", "debitamount", "charges", "invoiced"],
  credit: ["credit", "cr", "creditamount", "payments", "paid", "receipts", "receipt"],
  amount: ["amount", "gross", "grossamount", "total", "value", "amountgross", "balance"],
  delivery_ref: ["delivery", "deliveryno", "deliverynumber", "deliverynote", "dn", "dnno", "dnnumber"],
  po_ref: ["po", "pono", "ponumber", "purchaseorder", "purchaseorderno", "order", "orderno"],
  due_date: ["due", "duedate", "paymentdue"],
  currency: ["currency", "curr", "ccy"],
  account_ref: ["account", "accountno", "accountnumber", "address", "addressnumber", "customer", "customerno", "customernumber"],
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Suggest which column holds which field from the header names. Exact name beats partial match. */
export function guessSoaMapping(headers: string[]): Partial<Record<SoaField, number>> {
  const norm = headers.map(squash);
  const used = new Set<number>();
  const result: Partial<Record<SoaField, number>> = {};

  // Two passes so exact matches claim columns before partial matches do.
  for (const pass of ["exact", "partial"] as const) {
    for (const field of Object.keys(SYNONYMS) as SoaField[]) {
      if (result[field] !== undefined) continue;
      const idx = norm.findIndex((h, i) => {
        if (used.has(i) || h === "") return false;
        return pass === "exact"
          ? SYNONYMS[field].includes(h)
          : SYNONYMS[field].some((s) => s.length >= 4 && h.includes(s));
      });
      if (idx >= 0) {
        result[field] = idx;
        used.add(idx);
      }
    }
  }
  // A single amount column is only useful when there are no debit/credit columns.
  if (result.debit !== undefined || result.credit !== undefined) delete result.amount;
  return result;
}

/** Interpret free-text entry types such as "Invoice", "Credit Note", "Receipt", "CHQ". */
export function classifyEntryType(text: string): SoaEntryType | null {
  const t = text.toLowerCase();
  if (/credit\s*(memo|note)|\bcn\b|\brm\b/.test(t)) return "credit_note";
  if (/debit\s*(memo|note)|\bdn\b/.test(t)) return "debit_note";
  if (/pay|receipt|cash|cheque|check|chq|transfer|bank|settle/.test(t)) return "payment";
  if (/inv/.test(t)) return "invoice";
  if (/open/.test(t)) return "opening_balance";
  if (/adjust/.test(t)) return "adjustment";
  return null;
}

function toIsoDate(v: CellValue, format: SoaMapping["dateFormat"]): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) {
      // Excel serial date
      return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
    }
    return null;
  }
  const s = String(v).trim();
  if (format === "iso") return parseIsoDate(s);
  if (format === "mdy") {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    return m ? parseDayFirstDate(`${m[2]}/${m[1]}/${m[3]}`) : null;
  }
  return parseDayFirstDate(s) ?? parseIsoDate(s);
}

const err = (field: string, code: string, message: string): RowIssue => ({ field, code, message, severity: "error" });
const warn = (field: string, code: string, message: string): RowIssue => ({ field, code, message, severity: "warning" });

/**
 * Turn spreadsheet rows (below the header) into statement rows.
 * `firstDataRowNumber` is the spreadsheet row number of rows[0], used for traceability.
 */
export function rowsToSoa(
  rows: CellValue[][],
  headers: string[],
  mapping: SoaMapping,
  firstDataRowNumber: number,
): ParsedSoaRow[] {
  const col = (r: CellValue[], f: SoaField): CellValue => {
    const i = mapping.columns[f];
    return i === undefined ? null : (r[i] ?? null);
  };
  const text = (r: CellValue[], f: SoaField) => {
    const t = cellToText(col(r, f)).trim();
    return t === "" ? null : t;
  };

  const out: ParsedSoaRow[] = [];
  rows.forEach((r, idx) => {
    if (r.every((c) => c === null)) return; // blank line

    const issues: RowIssue[] = [];
    const rawObj: Record<string, string> = {};
    headers.forEach((h, i) => {
      const t = cellToText(r[i] ?? null);
      if (t !== "") rawObj[h || `col${i + 1}`] = t;
    });

    const docDate = toIsoDate(col(r, "doc_date"), mapping.dateFormat);
    if (!docDate) issues.push(err("doc_date", "invalid_date", "Date is missing or not a valid date in the chosen format."));

    const docNumber = text(r, "doc_number");
    if (!docNumber) issues.push(err("doc_number", "missing_reference", "Document number is missing."));

    let debit = d(0);
    let credit = d(0);
    const parse = (f: SoaField) => {
      const raw = col(r, f);
      if (raw === null) return null;
      const p = parseAmount(raw);
      if (p === null) issues.push(err(f, "invalid_amount", `"${cellToText(raw)}" is not a valid amount.`));
      return p;
    };

    if (mapping.amountMode === "debit_credit") {
      const dv = parse("debit");
      const cv = parse("credit");
      if (dv?.isNegative() || cv?.isNegative()) {
        issues.push(err("amount", "negative_amount", "Debit and credit columns must not contain negative numbers."));
      }
      debit = dv?.abs() ?? d(0);
      credit = cv?.abs() ?? d(0);
      if (debit.gt(0) && credit.gt(0)) {
        issues.push(err("amount", "both_sides", "Both debit and credit have a value on the same row."));
      }
    } else {
      const av = parse("amount");
      if (av) {
        const increases = mapping.signedPositive === "debit" ? !av.isNegative() : av.isNegative();
        if (increases) debit = av.abs();
        else credit = av.abs();
      }
    }
    if (debit.isZero() && credit.isZero() && !issues.some((i) => i.field === "amount" || i.code === "invalid_amount")) {
      issues.push(warn("amount", "zero_amount", "Row has no amount."));
    }

    // Entry type: from the type column when there is one, otherwise from which side holds the amount.
    let entryType: SoaEntryType | null = null;
    const typeText = text(r, "entry_type");
    if (typeText) {
      entryType = classifyEntryType(typeText);
      if (!entryType) {
        issues.push(warn("entry_type", "unknown_type", `Entry type "${typeText}" not recognised; stored as "other".`));
        entryType = "other";
      }
    } else if (credit.gt(0)) {
      entryType = mapping.defaultType === "invoice" ? "payment" : mapping.defaultType;
    } else {
      entryType = mapping.defaultType;
    }

    // Make the amount side agree with the type (a credit note is always a credit, an invoice a debit).
    if (entryType === "credit_note" || entryType === "payment") {
      if (debit.gt(0) && credit.isZero()) {
        credit = debit;
        debit = d(0);
        issues.push(warn("amount", "side_adjusted", "Amount was in the debit column but the type is a credit; treated as a credit."));
      }
    } else if (entryType === "invoice" || entryType === "debit_note") {
      if (credit.gt(0) && debit.isZero()) {
        debit = credit;
        credit = d(0);
        issues.push(warn("amount", "side_adjusted", "Amount was in the credit column but the type is a charge; treated as a debit."));
      }
    }

    const dueRaw = col(r, "due_date");
    const dueDate = dueRaw === null ? null : toIsoDate(dueRaw, mapping.dateFormat);
    if (dueRaw !== null && !dueDate) {
      issues.push(warn("due_date", "invalid_due_date", "Due date could not be read and was ignored."));
    }
    const currencyText = text(r, "currency")?.toUpperCase() ?? null;
    out.push({
      rowNumber: firstDataRowNumber + idx,
      raw: JSON.stringify(rawObj),
      entryType,
      docDate,
      docNumber,
      accountRef: text(r, "account_ref"),
      deliveryRef: text(r, "delivery_ref"),
      poRef: text(r, "po_ref"),
      dueDate,
      currency: currencyText && /^[A-Z]{3}$/.test(currencyText) ? currencyText : null,
      description: text(r, "description"),
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      issues,
    });
  });
  return out;
}
