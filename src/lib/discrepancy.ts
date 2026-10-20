import { FINDING_LABEL } from "@/lib/reconcile/engine";

export const DISCREPANCY_STATUSES = ["open", "under_review", "waiting_supplier", "waiting_finance", "resolved", "closed"] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

export const STATUS_LABEL: Record<DiscrepancyStatus, string> = {
  open: "Open",
  under_review: "Under review",
  waiting_supplier: "Waiting for supplier",
  waiting_finance: "Waiting for finance",
  resolved: "Resolved",
  closed: "Closed",
};

export const STATUS_TONE: Record<DiscrepancyStatus, "red" | "amber" | "blue" | "green" | "gray"> = {
  open: "red",
  under_review: "amber",
  waiting_supplier: "blue",
  waiting_finance: "blue",
  resolved: "green",
  closed: "gray",
};

export const TYPE_LABEL: Record<string, string> = { ...FINDING_LABEL, manual: "Added manually" };
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, " ");

export const ACTIVE_STATUSES: DiscrepancyStatus[] = ["open", "under_review", "waiting_supplier", "waiting_finance"];

export const REFUND_TYPES = ["overpayment", "duplicate_payment", "credit_note_pending", "excess_charge", "other"] as const;
export const REFUND_TYPE_LABEL: Record<string, string> = {
  overpayment: "Overpayment",
  duplicate_payment: "Duplicate payment",
  credit_note_pending: "Credit note not yet refunded",
  excess_charge: "Excess charge",
  other: "Other",
};
export const REFUND_STATUSES = ["draft", "submitted", "acknowledged", "partially_received", "received", "rejected"] as const;
export const REFUND_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted to supplier",
  acknowledged: "Acknowledged",
  partially_received: "Partly received",
  received: "Received",
  rejected: "Rejected",
};
