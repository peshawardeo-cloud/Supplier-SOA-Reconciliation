export type Supplier = {
  id: string;
  code: string;
  name: string;
  vat_number: string | null;
  cr_number: string | null;
  account_ref: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  currency: string;
  payment_terms_days: number | null;
  notes: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
};

export type PeriodStatus = "draft" | "in_progress" | "under_review" | "completed" | "locked";

export const PERIOD_STATUSES: PeriodStatus[] = [
  "draft",
  "in_progress",
  "under_review",
  "completed",
  "locked",
];

export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = {
  draft: "Draft",
  in_progress: "In progress",
  under_review: "Under review",
  completed: "Completed",
  locked: "Locked",
};

/** Periods in these states accept imports. */
export const OPEN_PERIOD_STATUSES: PeriodStatus[] = ["draft", "in_progress"];

export type Period = {
  id: string;
  supplier_id: string;
  period_start: string;
  period_end: string;
  statement_date: string | null;
  status: PeriodStatus;
  reported_opening_balance: string | null;
  reported_closing_balance: string | null;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
};

export type ImportStatus = "uploaded" | "needs_mapping" | "staged" | "committed" | "failed" | "reverted";

export const IMPORT_STATUS_LABEL: Record<ImportStatus, string> = {
  uploaded: "Uploaded",
  needs_mapping: "Needs column mapping",
  staged: "Ready for review",
  committed: "Imported",
  failed: "Failed",
  reverted: "Reverted",
};

export type ControlCheck = { label: string; printed: string; parsed: string; ok: boolean };

export type BatchControl = {
  supplierName?: string;
  accountRef?: string;
  accountName?: string;
  dateFrom?: string;
  dateTo?: string;
  closingBalance?: string;
  checks?: ControlCheck[];
  identity?: { name_match: boolean | null; account_match: boolean | null };
  outside_period_count?: number;
  warnings?: string[];
};

export type ImportBatch = {
  id: string;
  supplier_id: string;
  period_id: string | null;
  import_type: "soa" | "po" | "dn" | "invoice";
  file_name: string;
  file_kind: "pdf" | "xlsx" | "csv";
  storage_path: string;
  file_hash: string;
  sheet_name: string | null;
  column_mapping: unknown;
  status: ImportStatus;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  duplicate_rows: number;
  imported_rows: number;
  control: BatchControl | null;
  error_message: string | null;
  created_at: string;
  committed_at: string | null;
  reverted_at: string | null;
  revert_reason: string | null;
};
