import Decimal from "decimal.js";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { saveSettings } from "./actions";

type SettingsRow = {
  vat_rate: string;
  amount_tolerance_abs: string;
  amount_tolerance_pct: string;
  qty_tolerance: string;
  date_window_days: number;
  rounding_mode: string;
  default_currency: string;
  doc_number_rules: {
    strip_leading_zeros?: boolean;
    strip_prefixes?: string[];
  };
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requireRole(["admin"]);
  const { error, saved } = await searchParams;

  const supabase = await createClient();
  const { data: s } = await supabase
    .from("app_settings")
    .select("*")
    .eq("id", true)
    .single<SettingsRow>();

  if (!s) {
    return (
      <p className="text-sm text-red-700">
        Settings could not be loaded. Check that migration 0001 was run in Supabase.
      </p>
    );
  }

  const pct = (fraction: string) => new Decimal(fraction).mul(100).toString();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-600">
          These values are used by imports and the reconciliation engine. Every change is recorded
          in the audit log.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Settings saved.
        </p>
      )}

      <form action={saveSettings} className="card grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="vat_rate_percent" className="label">
            Default VAT rate (%)
          </label>
          <input
            id="vat_rate_percent"
            name="vat_rate_percent"
            type="number"
            step="0.01"
            min="0"
            max="100"
            required
            defaultValue={pct(s.vat_rate)}
            className="input"
          />
        </div>

        <div>
          <label htmlFor="default_currency" className="label">
            Default currency
          </label>
          <input
            id="default_currency"
            name="default_currency"
            maxLength={3}
            required
            defaultValue={s.default_currency}
            className="input uppercase"
          />
        </div>

        <div>
          <label htmlFor="amount_tolerance_abs" className="label">
            Amount tolerance (fixed amount)
          </label>
          <input
            id="amount_tolerance_abs"
            name="amount_tolerance_abs"
            type="number"
            step="0.01"
            min="0"
            required
            defaultValue={s.amount_tolerance_abs}
            className="input"
          />
          <p className="mt-1 text-xs text-slate-500">Differences up to this are treated as equal.</p>
        </div>

        <div>
          <label htmlFor="amount_tolerance_percent" className="label">
            Amount tolerance (% of gross)
          </label>
          <input
            id="amount_tolerance_percent"
            name="amount_tolerance_percent"
            type="number"
            step="0.0001"
            min="0"
            max="100"
            required
            defaultValue={pct(s.amount_tolerance_pct)}
            className="input"
          />
          <p className="mt-1 text-xs text-slate-500">The larger of the two tolerances applies.</p>
        </div>

        <div>
          <label htmlFor="qty_tolerance" className="label">
            Quantity tolerance
          </label>
          <input
            id="qty_tolerance"
            name="qty_tolerance"
            type="number"
            step="0.001"
            min="0"
            required
            defaultValue={s.qty_tolerance}
            className="input"
          />
        </div>

        <div>
          <label htmlFor="date_window_days" className="label">
            Date window for suggested matches (days)
          </label>
          <input
            id="date_window_days"
            name="date_window_days"
            type="number"
            step="1"
            min="0"
            max="365"
            required
            defaultValue={s.date_window_days}
            className="input"
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="strip_prefixes" className="label">
            Document-number prefixes to ignore when matching
          </label>
          <input
            id="strip_prefixes"
            name="strip_prefixes"
            placeholder="e.g. INV, PO, DN"
            defaultValue={(s.doc_number_rules.strip_prefixes ?? []).join(", ")}
            className="input"
          />
          <p className="mt-1 text-xs text-slate-500">
            Comma-separated. The original document number is always kept as imported.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="strip_leading_zeros"
              defaultChecked={s.doc_number_rules.strip_leading_zeros ?? false}
              className="h-4 w-4 rounded border-slate-300"
            />
            Ignore leading zeros in document numbers when matching
          </label>
        </div>

        <div className="sm:col-span-2">
          <p className="text-xs text-slate-500">
            Rounding: {s.rounding_mode === "half_up" ? "half-up to 2 decimals" : s.rounding_mode}
          </p>
        </div>

        <div className="sm:col-span-2">
          <button type="submit" className="btn w-full sm:w-auto">
            Save settings
          </button>
        </div>
      </form>
    </div>
  );
}
