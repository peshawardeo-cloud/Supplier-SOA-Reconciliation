/** `error` rows are rejected from import; `warning` rows import but are shown for review. */
export type RowIssue = {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type SoaEntryType =
  | "invoice"
  | "credit_note"
  | "debit_note"
  | "payment"
  | "opening_balance"
  | "adjustment"
  | "other";

export const SOA_ENTRY_TYPES: SoaEntryType[] = [
  "invoice",
  "credit_note",
  "debit_note",
  "payment",
  "opening_balance",
  "adjustment",
  "other",
];

/** One statement line, after parsing. Amounts are decimal strings, never floats. */
export type ParsedSoaRow = {
  rowNumber: number;
  /** Original text (PDF line) or JSON of the spreadsheet row, kept for traceability. */
  raw: string;
  entryType: SoaEntryType | null;
  docDate: string | null; // ISO yyyy-mm-dd
  docNumber: string | null;
  accountRef: string | null; // our account number at the supplier
  deliveryRef: string | null;
  poRef: string | null;
  dueDate: string | null; // ISO
  currency: string | null;
  description: string | null;
  debit: string; // increases what we owe
  credit: string; // reduces what we owe
  issues: RowIssue[];
};

/** Figures printed on the statement itself, used to check that we read it correctly. */
export type SoaControl = {
  supplierName?: string;
  preparedBy?: string;
  accountRef?: string;
  accountName?: string;
  dateFrom?: string; // ISO
  dateTo?: string; // ISO
  invoiceTotal?: string;
  receiptTotal?: string;
  closingBalance?: string;
  invoiceCount?: number;
  receiptCount?: number;
};

export type ParsedSoa = {
  rows: ParsedSoaRow[];
  control: SoaControl;
  /** Lines that looked like data but could not be understood, for the user to see. */
  warnings: string[];
};
