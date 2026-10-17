import { d, parseAmount } from "@/lib/money";
import { parseDayFirstDate } from "./dates";
import type { ParsedSoa, ParsedSoaRow, RowIssue, SoaControl } from "./types";

/**
 * Parser for text-based statement PDFs in the layout used by Saudi Vetonit (SAVETO):
 *
 *   G/L Date | Address No | Invoice No | Invoice Type | Delivery No | Amount Gross | Receipt No | Check Amount | Explanation
 *
 *  - "Invoice" lines increase the balance (debit).
 *  - "Credit Memo" lines print a trailing minus (5,980.00-) and reduce it (credit).
 *  - "Hand Held Cash Order" lines are payments: receipt number + check amount (credit).
 *
 * It works on visual lines of text (see pdf.ts), so it can be unit-tested without a PDF.
 * Any line that starts with a date but cannot be understood is kept as a rejected row
 * so nothing is silently dropped.
 */

const DATE = String.raw`\d{2}\/\d{2}\/\d{4}`;
const AMT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}-?`;

const INVOICE_LINE = new RegExp(
  String.raw`^(${DATE})\s+(\d+)\s+(\S+)\s+(Invoice|Credit Memo|Debit Memo)\s+(?:(\d+)\s+)?(${AMT})$`,
);
const PAYMENT_LINE = new RegExp(
  // Payments carry no invoice number (printed as 0): date, account, 0, type text, receipt no, amount, remark.
  String.raw`^(${DATE})\s+(\d+)\s+0\s+(.+?)\s+(\S+)\s+(${AMT})(?:\s+(.*))?$`,
);
const DATA_START = new RegExp(String.raw`^${DATE}\s`);
const HEADER_LINE = new RegExp(String.raw`^(\S+)\s+(.+?)\s+(${DATE})\s+\d{2}:\d{2}:\d{2}$`);
const RANGE_LINE = new RegExp(String.raw`Date From:\s*(${DATE})\s+Date To:\s*(${DATE})`);
const TOTALS_LINE = new RegExp(String.raw`^(${AMT})\s+(${AMT})$`);
const CLOSING_LINE = new RegExp(
  String.raw`^[A-Za-z ]+:\s*(\d+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(${AMT})\s+(${AMT})$`,
);

function amountOrNull(raw: string) {
  return parseAmount(raw);
}

function issue(field: string, code: string, message: string, severity: RowIssue["severity"] = "error"): RowIssue {
  return { field, code, message, severity };
}

export function parseSoaLines(lines: string[]): ParsedSoa {
  const rows: ParsedSoaRow[] = [];
  const warnings: string[] = [];
  const control: SoaControl = {};
  let rowNumber = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    // ---- control information printed on the statement ----
    const range = RANGE_LINE.exec(line);
    if (range) {
      control.dateFrom ??= parseDayFirstDate(range[1]) ?? undefined;
      control.dateTo ??= parseDayFirstDate(range[2]) ?? undefined;
      continue;
    }

    if (!DATA_START.test(line)) {
      const closing = CLOSING_LINE.exec(line);
      if (closing) {
        control.accountRef = closing[1];
        control.accountName = closing[2].trim();
        control.invoiceCount = Number(closing[3]);
        control.receiptCount = Number(closing[4]);
        control.closingBalance = amountOrNull(closing[6])?.toFixed(2);
        continue;
      }
      const totals = TOTALS_LINE.exec(line);
      if (totals) {
        control.invoiceTotal = amountOrNull(totals[1])?.toFixed(2);
        control.receiptTotal = amountOrNull(totals[2])?.toFixed(2);
        continue;
      }
      const header = HEADER_LINE.exec(line);
      if (header && !control.supplierName) {
        control.preparedBy = header[1];
        control.supplierName = header[2].trim();
      }
      continue; // page headers, column titles, footers, Arabic disclaimer, etc.
    }

    // ---- data rows ----
    rowNumber += 1;
    const base: ParsedSoaRow = {
      rowNumber,
      raw: line,
      entryType: null,
      docDate: null,
      docNumber: null,
      accountRef: null,
      deliveryRef: null,
      poRef: null,
      dueDate: null,
      currency: null,
      description: null,
      debit: "0.00",
      credit: "0.00",
      issues: [],
    };

    const inv = INVOICE_LINE.exec(line);
    if (inv) {
      const [, date, account, docNo, typeText, delivery, amountText] = inv;
      const amount = amountOrNull(amountText)!;
      base.docDate = parseDayFirstDate(date);
      base.accountRef = account;
      base.docNumber = docNo;
      base.deliveryRef = delivery ?? null;

      if (typeText === "Invoice") {
        base.entryType = "invoice";
        if (amount.isNegative()) {
          base.credit = amount.abs().toFixed(2);
          base.issues.push(issue("amount", "negative_invoice", "Invoice has a negative amount; treated as a credit.", "warning"));
        } else base.debit = amount.toFixed(2);
      } else if (typeText === "Credit Memo") {
        base.entryType = "credit_note";
        base.credit = amount.abs().toFixed(2);
        if (!amount.isNegative()) {
          base.issues.push(issue("amount", "unexpected_sign", "Credit memo is not shown as negative; treated as a credit.", "warning"));
        }
      } else {
        base.entryType = "debit_note";
        base.debit = amount.abs().toFixed(2);
      }
    } else {
      const pay = PAYMENT_LINE.exec(line);
      if (pay) {
        const [, date, account, typeText, receiptNo, amountText, explanation] = pay;
        const amount = amountOrNull(amountText)!;
        base.entryType = "payment";
        base.docDate = parseDayFirstDate(date);
        base.accountRef = account;
        base.docNumber = receiptNo;
        base.description = [typeText, explanation].filter(Boolean).join(" - ");
        base.credit = amount.abs().toFixed(2);
        if (amount.isNegative()) {
          base.issues.push(issue("amount", "negative_payment", "Payment has a negative amount.", "warning"));
        }
      } else {
        base.issues.push(issue("row", "unrecognized_line", "This line looks like a statement entry but its layout was not recognised."));
        warnings.push(`Unrecognised line: ${line}`);
        rows.push(base);
        continue;
      }
    }

    if (!base.docDate) base.issues.push(issue("doc_date", "invalid_date", "Date is not a valid DD/MM/YYYY date."));
    if (!base.docNumber || base.docNumber === "0") {
      base.issues.push(issue("doc_number", "missing_reference", "Document number is missing."));
    }
    rows.push(base);
  }

  return { rows, control, warnings };
}

/**
 * Totals computed from the parsed rows, for comparison with the statement's printed figures.
 * This supplier's statement counts credit memos inside its "invoice" figures, so:
 *   documentsNet  = invoices + debit notes - credit notes
 *   documentCount = invoices + credit notes + debit notes
 */
export function computeSoaTotals(rows: ParsedSoaRow[]) {
  const usable = rows.filter((r) => !r.issues.some((i) => i.severity === "error"));
  let debit = d(0);
  let credit = d(0);
  let documentsNet = d(0);
  let paymentsTotal = d(0);
  let documentCount = 0;
  let paymentCount = 0;
  for (const r of usable) {
    debit = debit.plus(r.debit);
    credit = credit.plus(r.credit);
    if (r.entryType === "payment") {
      paymentsTotal = paymentsTotal.plus(r.credit);
      paymentCount += 1;
    } else {
      documentsNet = documentsNet.plus(r.debit).minus(r.credit);
      documentCount += 1;
    }
  }
  return {
    debit,
    credit,
    balance: debit.minus(credit),
    documentsNet,
    paymentsTotal,
    documentCount,
    paymentCount,
    rowCount: usable.length,
  };
}

export type ControlCheck = { label: string; printed: string; parsed: string; ok: boolean };

/** Compare what we parsed with what the statement itself says. Only figures that exist are checked. */
export function compareSoaControl(control: SoaControl, rows: ParsedSoaRow[]): ControlCheck[] {
  const t = computeSoaTotals(rows);
  const checks: ControlCheck[] = [];
  const money = (label: string, printed: string | undefined, parsed: string) => {
    if (printed === undefined) return;
    checks.push({ label, printed, parsed, ok: d(printed).eq(parsed) });
  };
  money("Documents total (invoices less credit memos)", control.invoiceTotal, t.documentsNet.toFixed(2));
  money("Payments total", control.receiptTotal, t.paymentsTotal.toFixed(2));
  money("Closing balance", control.closingBalance, t.balance.toFixed(2));
  if (control.invoiceCount !== undefined) {
    checks.push({
      label: "Document count",
      printed: String(control.invoiceCount),
      parsed: String(t.documentCount),
      ok: control.invoiceCount === t.documentCount,
    });
  }
  if (control.receiptCount !== undefined) {
    checks.push({
      label: "Payment count",
      printed: String(control.receiptCount),
      parsed: String(t.paymentCount),
      ok: control.receiptCount === t.paymentCount,
    });
  }
  return checks;
}
