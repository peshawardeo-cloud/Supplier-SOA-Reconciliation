import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();

export const supplierSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Supplier code is required")
    .max(30, "Supplier code is too long")
    .regex(/^[A-Za-z0-9._-]+$/, "Code may only contain letters, numbers, dot, dash and underscore")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, "Supplier name is required").max(200),
  vat_number: optionalText(30),
  cr_number: optionalText(30),
  account_ref: optionalText(40),
  contact_name: optionalText(120),
  email: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Email address is not valid"),
  phone: optionalText(40),
  address: optionalText(500),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code such as SAR"),
  payment_terms_days: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .nullable()
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 365), "Payment terms must be 0 to 365 days"),
  notes: optionalText(2000),
});

export type SupplierInput = z.infer<typeof supplierSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");

const optionalMoney = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v.replace(/,/g, "")))
  .nullable()
  .refine((v) => v === null || /^-?\d+(\.\d{1,2})?$/.test(v), "Amounts need at most 2 decimals");

export const periodSchema = z
  .object({
    supplier_id: z.string().uuid(),
    period_start: isoDate,
    period_end: isoDate,
    statement_date: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Enter a valid statement date"),
    reported_opening_balance: optionalMoney,
    reported_closing_balance: optionalMoney,
    notes: optionalText(2000),
  })
  .refine((v) => v.period_end >= v.period_start, {
    message: "Period end must not be before period start",
    path: ["period_end"],
  });

export const periodStatusSchema = z.object({
  supplier_id: z.string().uuid(),
  period_id: z.string().uuid(),
  status: z.enum(["draft", "in_progress", "under_review", "completed", "locked"]),
});
