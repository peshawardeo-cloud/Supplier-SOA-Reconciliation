import { Field } from "@/components/ui";
import type { Supplier } from "@/lib/types";

type Props = {
  action: (formData: FormData) => Promise<void>;
  supplier?: Supplier;
  submitLabel: string;
  cancelHref: string;
  defaultCurrency: string;
};

export function SupplierForm({ action, supplier: s, submitLabel, cancelHref, defaultCurrency }: Props) {
  return (
    <form action={action} className="card grid gap-4 sm:grid-cols-2">
      {s && <input type="hidden" name="id" value={s.id} />}

      <Field label="Supplier code (required)" htmlFor="code" hint="Your short reference, e.g. SAVETO. Must be unique.">
        <input id="code" name="code" required maxLength={30} defaultValue={s?.code ?? ""} className="input uppercase" />
      </Field>
      <Field label="Supplier name (required)" htmlFor="name">
        <input id="name" name="name" required maxLength={200} defaultValue={s?.name ?? ""} className="input" />
      </Field>

      <Field label="VAT number" htmlFor="vat_number">
        <input id="vat_number" name="vat_number" maxLength={30} defaultValue={s?.vat_number ?? ""} className="input" />
      </Field>
      <Field label="Commercial registration (CR) number" htmlFor="cr_number">
        <input id="cr_number" name="cr_number" maxLength={30} defaultValue={s?.cr_number ?? ""} className="input" />
      </Field>

      <Field
        label="Our account number at this supplier"
        htmlFor="account_ref"
        hint="Printed on their statements (e.g. the customer / address number). Used to confirm a statement belongs to this supplier."
      >
        <input id="account_ref" name="account_ref" maxLength={40} defaultValue={s?.account_ref ?? ""} className="input" />
      </Field>
      <Field label="Contact person" htmlFor="contact_name">
        <input id="contact_name" name="contact_name" maxLength={120} defaultValue={s?.contact_name ?? ""} className="input" />
      </Field>

      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" maxLength={200} defaultValue={s?.email ?? ""} className="input" />
      </Field>
      <Field label="Phone" htmlFor="phone">
        <input id="phone" name="phone" maxLength={40} defaultValue={s?.phone ?? ""} className="input" />
      </Field>

      <Field label="Currency" htmlFor="currency">
        <input
          id="currency"
          name="currency"
          required
          maxLength={3}
          defaultValue={s?.currency ?? defaultCurrency}
          className="input uppercase"
        />
      </Field>
      <Field label="Payment terms (days)" htmlFor="payment_terms_days" hint="e.g. 90 for Net 90 days">
        <input
          id="payment_terms_days"
          name="payment_terms_days"
          type="number"
          min={0}
          max={365}
          step={1}
          defaultValue={s?.payment_terms_days ?? ""}
          className="input"
        />
      </Field>

      <Field label="Address" htmlFor="address" className="sm:col-span-2">
        <textarea id="address" name="address" rows={2} maxLength={500} defaultValue={s?.address ?? ""} className="input" />
      </Field>

      {!s && (
        <Field
          label="Other names this supplier appears under"
          htmlFor="aliases"
          hint="Optional. One per line or comma-separated, e.g. the name printed on their statements."
          className="sm:col-span-2"
        >
          <textarea id="aliases" name="aliases" rows={2} className="input" />
        </Field>
      )}

      <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
        <textarea id="notes" name="notes" rows={2} maxLength={2000} defaultValue={s?.notes ?? ""} className="input" />
      </Field>

      {s && (
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="is_active" defaultChecked={s.is_active} className="h-4 w-4 rounded border-slate-300" />
          Active supplier
        </label>
      )}

      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
        <button type="submit" className="btn">
          {submitLabel}
        </button>
        <a href={cancelHref} className="btn-secondary">
          Cancel
        </a>
      </div>
    </form>
  );
}
