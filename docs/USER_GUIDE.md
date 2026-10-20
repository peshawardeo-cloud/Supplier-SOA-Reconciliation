# User guide: Supplier SOA Reconciliation

## The daily workflow

1. **Supplier** – Suppliers → open (or add) the supplier. Fill in the VAT number and your account number at the supplier: the system uses them to catch a file that belongs to a different supplier.
2. **Documents** – on the supplier page open **Invoices / Purchase orders / Delivery notes / Payments** → *Import*.
   - Supplier tax-invoice PDFs: select many at once. Each is read and its printed total is compared with its lines.
   - Excel (.xlsx) or CSV: match the columns once; it is remembered for that supplier.
   - Documents already on file are skipped. If any line of a document has an error the whole document is held back.
   - Review, then **Import** (or **Import all clean files**).
3. **Statement** – create a reconciliation period, open it and import the supplier's statement (SOA). Check the "statement totals check".
4. **Reconcile** – open the period → **Open reconciliation** → **Run reconciliation**. You can run it as often as you like; decisions you made are kept.
5. **Review matches**
   - *Exact* matches (same document number) are confirmed automatically.
   - *Suggested* matches (similar number plus at least two supporting facts: amount, date, PO) wait for you to **Confirm** or **Reject**. An amount on its own never creates a match.
   - Match any remaining statement line by hand from the list.
6. **Apply payments** – supplier page → *Apply payments*. A payment or credit note can only be applied up to its own amount, and an invoice only up to its total. Nothing is applied automatically; *Apply oldest first* is a button you press.
7. **Discrepancies** – everything the run finds appears under *Discrepancies* with the figures and the calculation behind each. Set a status (Open, Under review, Waiting for supplier, Waiting for finance, Resolved, Closed), assign it, add notes. Resolving needs a note. Every change is recorded in the history.
8. **Refund claims** – record money the supplier owes back, and track it to receipt.
9. **Dashboard** – totals and a results table you can filter by supplier, period, PO number, invoice number and status; **Export to Excel** downloads exactly what is filtered.
10. **Complete the period** – set the period to *Completed* when finished. An administrator can *Lock* it; matches and runs are then frozen.

## How the balance difference is explained

Difference = supplier-reported closing balance − our calculated closing balance. The reconciliation page lists what explains it: invoices only on the statement, invoices only in our records, amount differences on matched invoices, statement-only payments, our payments not on the statement, adjustments, and finally anything *not explained* (usually the statement's printed closing balance not equalling the sum of its own lines).

Our closing balance = the opening balance on the period + our invoices − credit notes − payments dated up to the period end (plus anything matched to this statement).

## Settings (administrator)

VAT rate (default 15%), amount tolerance (absolute and %), quantity tolerance, date window for supporting evidence, and document-number rules (ignore separators, leading zeros, prefixes). Each run stores the settings it used.

## Rules the system never breaks

- Imported documents and statement lines are never edited. Mistakes are fixed by reverting the import (administrator, with a reason) and importing again.
- The supplier's reported balance and our calculated balance are always kept apart.
- Nothing is deleted; removals are recorded with who, when and why.
- A match is never confirmed on amount alone.

## Defaults you may want to confirm with finance

The statement sign convention (debit = we owe more), how payments reach the system (import or typed in), and whether other suppliers' statements start from an opening balance. These are settings/assumptions, not hard-coded facts about your business.
