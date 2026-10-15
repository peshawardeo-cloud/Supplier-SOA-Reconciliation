import { z } from "zod";

/** Form values as typed by the admin (percentages are entered as 15, not 0.15). */
export const settingsFormSchema = z.object({
  vat_rate_percent: z.coerce.number().min(0).max(100),
  amount_tolerance_abs: z.coerce.number().min(0).max(1_000_000),
  amount_tolerance_percent: z.coerce.number().min(0).max(100),
  qty_tolerance: z.coerce.number().min(0).max(1_000_000),
  date_window_days: z.coerce.number().int().min(0).max(365),
  default_currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code such as SAR"),
  strip_leading_zeros: z.boolean(),
  strip_prefixes: z.array(z.string().min(1).max(20)).max(20),
});

export type SettingsForm = z.infer<typeof settingsFormSchema>;
