import { d, parseAmount, round2 } from "@/lib/money";
import { parseDayFirstDate, parseIsoDate } from "./dates";
import { cellToText, type CellValue } from "./tabular";
import type { RowIssue } from "./types";

/** The four document types that are imported line by line (the SOA has its own reader). */
export type DocKind = "po" | "dn" | "invoice" | "payment";

export const DOC_KINDS: DocKind[] = ["po", "dn", "invoice", "payment"];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  po: "Purchase orders",
  dn: "Delivery notes",
  invoice: "Supplier invoices",
  payment: "Payments",
};

export const DOC_KIND_SINGULAR: Record<DocKind, string> = {
  po: "purchase order",
  dn: "delivery note",
  invoice: "invoice",
  payment: "payment",
};

export type DocHeaderTotals = {
  net: string | null;
  vat: string | null;
  gross: string | null;
  paymentTermsDays: number | null;
};

/** One line of a document (or one payment). Header fields are repeated on every line of the same document. */
export type ParsedDocRow = {
  rowNumber: number;
  raw: string;
  kind: DocKind;
  docType: "invoice" | "credit_note" | null; // invoices only
  docNumber: string | null; // PO no. / DN no. / invoice no. / payment reference
  docDate: string | null; // ISO
  dueDate: string | null;
  currency: string | null;
  poRefs: string[];
  dnRefs: string[];
  projectRef: string | null;
  receivedBy: string | null;
  method: string | null;
  bankRef: string | null;
  lineNo: number | null;
  itemCode: string | null;
  description: string | null;
  uom: string | null;
  qty: string | null;
  unitPrice: string | null;
  net: string | null;
  vat: string | null;
  gross: string | null;
  vatCalculated: boolean;
  /** Totals printed on the document itself (PDF invoices), used to check the lines were all read. */
  header: DocHeaderTotals | null;
  issues: RowIssue[];
};

export type DocControl = {
  sellerVat?: string;
  buyerVat?: string;
  accountRef?: string;
  orderNo?: string;
  supplierName?: string;
};

export type ParsedDocs = { rows: ParsedDocRow[]; control: DocControl; warnings: string[] };

export function emptyDocRow(kind: DocKind, rowNumber: number, raw: string): ParsedDocRow {
  return {
    rowNumber,
    raw,
    kind,
    docType: kind === "invoice" ? "invoice" : null,
    docNumber: null,
    docDate: null,
    dueDate: null,
    currency: null,
    poRefs: [],
    dnRefs: [],
    projectRef: null,
    receivedBy: null,
    method: null,
    bankRef: null,
    lineNo: null,
    itemCode: null,
    description: null,
    uom: null,
    qty: null,
    unitPrice: null,
    net: null,
    vat: null,
    gross: null,
    vatCalculated: false,
    header: null,
    issues: [],
  };
}

/* ------------------------------------------------------------------ */
/* Spreadsheet fields                                                   */
/* ------------------------------------------------------------------ */

export type DocField =
  | "doc_number"
  | "doc_date"
  | "doc_type"
  | "due_date"
  | "po_ref"
  | "dn_ref"
  | "project_ref"
  | "received_by"
  | "method"
  | "bank_ref"
  | "currency"
  | "line_no"
  | "item_code"
  | "description"
  | "uom"
  | "qty"
  | "unit_price"
  | "net"
  | "vat"
  | "gross"
  | "amount";

export type FieldDef = { key: DocField; label: string; required?: boolean; hint?: string };

const f = (key: DocField, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, ...extra });

export const DOC_FIELDS: Record<DocKind, FieldDef[]> = {
  po: [
    f("doc_number", "PO number", { required: true }),
    f("doc_date", "PO date", { required: true }),
    f("qty", "Quantity ordered", { required: true }),
    f("unit_price", "Unit price"),
    f("net", "Line amount excluding VAT"),
    f("vat", "VAT amount"),
    f("gross", "Line amount including VAT"),
    f("item_code", "Item / material code"),
    f("description", "Item description"),
    f("uom", "Unit of measure"),
    f("line_no", "Line number"),
    f("project_ref", "Project / site"),
    f("currency", "Currency"),
  ],
  dn: [
    f("doc_number", "Delivery note number", { required: true }),
    f("doc_date", "Delivery date", { required: true }),
    f("qty", "Quantity delivered", { required: true }),
    f("po_ref", "PO number", { hint: "Several can be separated by commas" }),
    f("item_code", "Item / material code"),
    f("description", "Item description"),
    f("uom", "Unit of measure"),
    f("line_no", "Line number"),
    f("project_ref", "Project / site"),
    f("received_by", "Received by"),
  ],
  invoice: [
    f("doc_number", "Invoice number", { required: true }),
    f("doc_date", "Invoice date", { required: true }),
    f("net", "Amount excluding VAT", { hint: "Or map the total including VAT instead" }),
    f("vat", "VAT amount"),
    f("gross", "Amount including VAT"),
    f("doc_type", "Invoice / credit note type", { hint: "Optional column that says 'Credit Note'" }),
    f("po_ref", "PO number", { hint: "Several can be separated by commas" }),
    f("dn_ref", "Delivery note number", { hint: "Several can be separated by commas" }),
    f("due_date", "Due date"),
    f("qty", "Quantity"),
    f("unit_price", "Unit price"),
    f("item_code", "Item / material code"),
    f("description", "Item description"),
    f("uom", "Unit of measure"),
    f("line_no", "Line number"),
    f("currency", "Currency"),
  ],
  payment: [
    f("doc_number", "Payment reference", { required: true }),
    f("doc_date", "Payment date", { required: true }),
    f("amount", "Amount paid", { required: true }),
    f("method", "Payment method"),
    f("bank_ref", "Bank / cheque reference"),
    f("description", "Notes"),
    f("currency", "Currency"),
  ],
};

const SYN: Record<DocKind, Partial<Record<DocField, string[]>>> = {
  po: {
    doc_number: ["po", "pono", "ponumber", "purchaseorder", "purchaseorderno", "purchasingdocument", "ordernumber", "orderno", "documentno"],
    doc_date: ["podate", "orderdate", "date", "documentdate", "docdate", "createdon"],
    qty: ["qty", "quantity", "orderquantity", "orderedqty", "qtyordered"],
    unit_price: ["unitprice", "price", "netprice", "rate", "uprice"],
    net: ["net", "netamount", "netvalue", "amount", "linevalue", "taxableamount"],
    vat: ["vat", "vatamount", "tax", "taxamount"],
    gross: ["gross", "grossamount", "total", "totalamount", "totalincvat"],
    item_code: ["itemcode", "item", "material", "materialno", "materialcode", "pcode", "productcode", "sku"],
    description: ["description", "itemdescription", "materialdescription", "shorttext", "details"],
    uom: ["uom", "unit", "un", "unitofmeasure"],
    line_no: ["line", "lineno", "linenumber", "item", "itemno", "poitem"],
    project_ref: ["project", "projectref", "site", "costcenter", "wbs"],
    currency: ["currency", "curr", "ccy"],
  },
  dn: {
    doc_number: ["dn", "dnno", "dnnumber", "deliverynote", "deliveryno", "deliverynumber", "grn", "grnno", "materialdocument", "documentno"],
    doc_date: ["deliverydate", "dndate", "date", "postingdate", "receiptdate", "documentdate"],
    qty: ["qty", "quantity", "deliveredqty", "qtydelivered", "quantitydelivered", "receivedqty"],
    po_ref: ["po", "pono", "ponumber", "purchaseorder", "purchaseorderno", "order"],
    item_code: ["itemcode", "material", "materialno", "materialcode", "pcode", "productcode", "sku"],
    description: ["description", "itemdescription", "materialdescription", "shorttext"],
    uom: ["uom", "unit", "un", "unitofmeasure"],
    line_no: ["line", "lineno", "linenumber", "item", "itemno"],
    project_ref: ["project", "projectref", "site", "costcenter", "wbs"],
    received_by: ["receivedby", "receiver", "storekeeper", "signedby"],
  },
  invoice: {
    doc_number: ["invoice", "invoiceno", "invoicenumber", "invno", "invoicenum", "billingdocument", "documentno", "reference", "refno"],
    doc_date: ["invoicedate", "date", "documentdate", "docdate", "postingdate", "billingdate"],
    net: ["net", "netamount", "taxableamount", "amountexcvat", "amountexcludingvat", "totalexcludingvat", "subtotal", "amount"],
    vat: ["vat", "vatamount", "tax", "taxamount", "totalvat"],
    gross: ["gross", "grossamount", "total", "totalamount", "amountincvat", "totalincludingvat", "totalamountdue", "invoicetotal"],
    doc_type: ["type", "documenttype", "doctype", "invoicetype"],
    po_ref: ["po", "pono", "ponumber", "purchaseorder", "purchaseorderno", "pono", "order"],
    dn_ref: ["dn", "dnno", "deliverynote", "deliveryno", "deliverynumber", "deliveryref"],
    due_date: ["due", "duedate", "paymentdue"],
    qty: ["qty", "quantity"],
    unit_price: ["unitprice", "price", "uprice", "rate"],
    item_code: ["itemcode", "item", "material", "materialno", "pcode", "productcode", "sku"],
    description: ["description", "itemdescription", "details"],
    uom: ["uom", "unit", "un", "unitofmeasure"],
    line_no: ["line", "lineno", "linenumber"],
    currency: ["currency", "curr", "ccy"],
  },
  payment: {
    doc_number: ["paymentref", "paymentno", "paymentnumber", "payment", "voucher", "voucherno", "documentno", "reference", "chequeno", "transaction"],
    doc_date: ["paymentdate", "date", "valuedate", "postingdate", "documentdate"],
    amount: ["amount", "paid", "paidamount", "paymentamount", "total", "value"],
    method: ["method", "paymentmethod", "mode", "type"],
    bank_ref: ["bankref", "bankreference", "cheque", "chequeno", "transferref", "utr"],
    description: ["notes", "remarks", "description", "narration", "details"],
    currency: ["currency", "curr", "ccy"],
  },
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type DocMapping = {
  headerRow: number; // 1-based
  columns: Partial<Record<DocField, number>>;
  dateFormat: "dmy" | "mdy" | "iso";
  /** Invoices: a negative amount means the row is a credit note. */
  negativeIsCredit: boolean;
  sheet?: string;
};

/** Suggest columns from the header names. An exact name beats a partial one; a column is used once. */
export function guessDocColumns(kind: DocKind, headers: string[]): Partial<Record<DocField, number>> {
  const norm = headers.map(squash);
  const used = new Set<number>();
  const out: Partial<Record<DocField, number>> = {};
  const syn = SYN[kind];
  const fields = DOC_FIELDS[kind].map((x) => x.key);
  for (const pass of ["exact", "partial"] as const) {
    for (const field of fields) {
      if (out[field] !== undefined) continue;
      const words = syn[field] ?? [];
      const idx = norm.findIndex((h, i) => {
        if (used.has(i) || h === "") return false;
        return pass === "exact" ? words.includes(h) : words.some((w) => w.length >= 5 && h.includes(w));
      });
      if (idx >= 0) {
        out[field] = idx;
        used.add(idx);
      }
    }
  }
  if (kind === "invoice" || kind === "po") {
    // A single generic "amount" column should not be read as both net and gross.
    if (out.net !== undefined && out.gross !== undefined && out.net === out.gross) delete out.gross;
  }
  return out;
}

function splitRefs(text: string | null): string[] {
  if (!text) return [];
  return Array.from(new Set(text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)));
}

function toIso(v: CellValue, format: DocMapping["dateFormat"]): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
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

/** Convert spreadsheet rows (below the header) into document lines. `vatRate` is a fraction, e.g. "0.15". */
export function rowsToDocs(
  kind: DocKind,
  rows: CellValue[][],
  headers: string[],
  mapping: DocMapping,
  firstRowNumber: number,
  vatRate: string,
): ParsedDocRow[] {
  const col = (r: CellValue[], key: DocField): CellValue => {
    const i = mapping.columns[key];
    return i === undefined ? null : (r[i] ?? null);
  };
  const text = (r: CellValue[], key: DocField) => {
    const t = cellToText(col(r, key)).trim();
    return t === "" ? null : t;
  };

  const out: ParsedDocRow[] = [];
  rows.forEach((r, idx) => {
    if (r.every((c) => c === null)) return;
    const rawObj: Record<string, string> = {};
    headers.forEach((h, i) => {
      const t = cellToText(r[i] ?? null);
      if (t !== "") rawObj[h || `col${i + 1}`] = t;
    });

    const row = emptyDocRow(kind, firstRowNumber + idx, JSON.stringify(rawObj));
    const bad = (x: RowIssue) => row.issues.push(x);

    row.docNumber = text(r, "doc_number");
    if (!row.docNumber) bad(err("doc_number", "missing_reference", "Document number is missing."));
    row.docDate = toIso(col(r, "doc_date"), mapping.dateFormat);
    if (!row.docDate) bad(err("doc_date", "invalid_date", "Date is missing or not valid in the chosen format."));

    const dueRaw = col(r, "due_date");
    if (dueRaw !== null) {
      row.dueDate = toIso(dueRaw, mapping.dateFormat);
      if (!row.dueDate) bad(warn("due_date", "invalid_due_date", "Due date could not be read and was ignored."));
    }
    const cur = text(r, "currency")?.toUpperCase() ?? null;
    row.currency = cur && /^[A-Z]{3}$/.test(cur) ? cur : null;
    row.poRefs = splitRefs(text(r, "po_ref"));
    row.dnRefs = splitRefs(text(r, "dn_ref"));
    row.projectRef = text(r, "project_ref");
    row.receivedBy = text(r, "received_by");
    row.method = text(r, "method");
    row.bankRef = text(r, "bank_ref");
    row.itemCode = text(r, "item_code");
    row.description = text(r, "description");
    row.uom = text(r, "uom");

    const lineRaw = text(r, "line_no");
    if (lineRaw) {
      const n = Number(lineRaw);
      if (Number.isInteger(n) && n > 0) row.lineNo = n;
      else bad(warn("line_no", "invalid_line_no", "Line number ignored; lines are numbered automatically."));
    }

    const num = (key: DocField): ReturnType<typeof parseAmount> => {
      const raw = col(r, key);
      if (raw === null) return null;
      const p = parseAmount(raw);
      if (p === null) bad(err(key, "invalid_number", `"${cellToText(raw)}" is not a valid number.`));
      return p;
    };

    if (kind === "payment") {
      const amt = num("amount");
      if (amt === null) {
        if (!row.issues.some((i) => i.field === "amount")) bad(err("amount", "missing_amount", "Payment amount is missing."));
      } else if (!amt.gt(0)) {
        bad(err("amount", "non_positive_amount", "Payment amount must be greater than zero."));
      } else {
        row.gross = round2(amt).toFixed(2);
      }
      out.push(row);
      return;
    }

    const qty = num("qty");
    if (kind === "po" || kind === "dn") {
      if (qty === null) {
        if (!row.issues.some((i) => i.field === "qty")) bad(err("qty", "missing_qty", "Quantity is missing."));
      } else if (!qty.gt(0)) {
        bad(err("qty", "non_positive_qty", "Quantity must be greater than zero."));
      }
    }
    if (qty !== null && qty.gt(0)) row.qty = qty.toDecimalPlaces(3).toFixed(3);
    else if (qty !== null && kind === "invoice" && qty.isNegative()) row.qty = qty.abs().toDecimalPlaces(3).toFixed(3);

    if (kind === "dn") {
      row.poRefs = splitRefs(text(r, "po_ref"));
      out.push(row);
      return;
    }

    const price = num("unit_price");
    if (price !== null) row.unitPrice = price.abs().toDecimalPlaces(4).toFixed(4);
    let net = num("net");
    let vat = num("vat");
    let gross = num("gross");

    // Credit notes: by type column, or by negative amounts when the user said so.
    if (kind === "invoice") {
      const typeText = text(r, "doc_type");
      if (typeText && /credit|\bcn\b|\bcm\b|\brm\b/i.test(typeText)) row.docType = "credit_note";
      const negative = [net, vat, gross].some((v) => v && v.isNegative());
      if (negative) {
        if (mapping.negativeIsCredit) {
          row.docType = "credit_note";
        } else if (row.docType !== "credit_note") {
          bad(err("amount", "negative_amount", "Amount is negative. If negative rows are credit notes, tick that option on the mapping page."));
        }
        net = net?.abs() ?? null;
        vat = vat?.abs() ?? null;
        gross = gross?.abs() ?? null;
      }
    }

    // Fill in whatever is missing from what is there; remember when VAT was calculated rather than read.
    const rate = d(vatRate);
    if (net === null && qty && price) net = round2(qty.abs().mul(price.abs()));
    if (net !== null && gross !== null && vat === null) vat = gross.minus(net);
    else if (net === null && gross !== null && vat !== null) net = gross.minus(vat);
    else if (net !== null && vat !== null && gross === null) gross = net.plus(vat);
    else if (net !== null && vat === null && gross === null) {
      vat = round2(net.mul(rate));
      gross = net.plus(vat);
      row.vatCalculated = true;
    } else if (net === null && gross !== null && vat === null) {
      net = round2(gross.div(rate.plus(1)));
      vat = gross.minus(net);
      row.vatCalculated = true;
    }

    if (kind === "invoice" && net === null && gross === null) {
      bad(err("net", "missing_amount", "The row has no amount (map the net or gross amount column)."));
    }
    if (net) row.net = round2(net).toFixed(2);
    if (vat) row.vat = round2(vat).toFixed(2);
    if (gross) row.gross = round2(gross).toFixed(2);
    if (kind === "po" && row.net === null && !row.issues.length) {
      bad(warn("net", "no_amount", "No amount or unit price; only the quantity will be checked."));
    }
    out.push(row);
  });
  return out;
}
